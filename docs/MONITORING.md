# Supervision et alerte — HRFlow

> Le 15 août 2024 à 2 h 15 du matin, un client d'hôtel a téléphoné au numéro
> d'urgence parce qu'il ne pouvait pas accéder aux plannings du lendemain. La
> plateforme était tombée à 23 h 47. **Le système de supervision, c'était lui.**

---

## 1. Objectif chiffré

| Indicateur | 14 août 2024 | Objectif | Comment il est tenu |
|---|---|---|---|
| Détection (MTTD) | 2 h 28 | **< 2 min** | sonde toutes les 15 s, alerte après 1 min |
| Rétablissement (MTTR) | 3 h 07 | < 10 min | `scripts/rollback.sh`, mesuré à ~2 min |
| Perte de données (RPO) | 1 h 17 | < 15 min | sauvegardes horaires + journalisation continue |

Décomposition du budget de détection :

```
scrape (15 s) + confirmation `for: 1m` + notification (~15 s) ≈ 90 s
```

La confirmation d'une minute évite les alertes sur un incident de réseau
d'une seconde. C'est un compromis assumé : une alerte qui se déclenche pour rien
finit par être coupée, et on retombe dans la situation d'origine.

---

## 2. Ce qui est observé

### La sonde qui mentait

L'ancienne sonde était :

```js
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})
```

Elle ne vérifiait rien. Une supervision branchée dessus serait restée verte
pendant toute la durée de l'incident, ce qui est pire qu'une absence de
supervision : cela produit une fausse assurance.

### Les deux sondes actuelles

| Sonde | Question | Usage |
|---|---|---|
| `/health/live` | le processus répond-il ? | orchestrateur : faut-il redémarrer ? |
| `/health/ready` | le service peut-il traiter du trafic ? | supervision et répartiteur de charge |

La distinction est essentielle. Confondre les deux fait redémarrer en boucle un
service dont seule la base est momentanément indisponible — ce qui transforme un
incident passager en panne durable.

`/health/ready` interroge réellement chaque dépendance, avec un délai maximal, et
répond 503 si l'une d'elles est critique et indisponible :

```json
{
  "status": "unready",
  "service": "api-gateway",
  "version": "a1b2c3d",
  "dependencies": [
    { "name": "auth", "status": "up", "latencyMs": 3 },
    { "name": "paie", "status": "down", "latencyMs": 2001, "error": "Délai dépassé" }
  ]
}
```

L'alerte désigne donc directement le service fautif : la personne réveillée à
2 h du matin n'a pas à chercher.

### Trois angles complémentaires

1. **Sondes internes** — chaque service, depuis le réseau applicatif.
2. **Sonde externe** — depuis Internet, en HTTPS. Des services parfaitement
   sains derrière un certificat expiré donnent une plateforme inaccessible.
3. **Ressources** — base, disque, mémoire, pour anticiper la dégradation.

---

## 3. Alertes

Configuration : [`monitoring/alertes.yml`](../monitoring/alertes.yml).

| Alerte | Gravité | Déclenchement | Astreinte |
|---|---|---|---|
| `PlateformeInaccessible` | P1 | sonde externe en échec 1 min | oui |
| `ServiceIndisponible` | P1 | `/health/ready` en échec 1 min | oui |
| `BaseDeDonneesInjoignable` | P1 | 30 s | oui |
| `LatenceElevee` | P2 | > 2 s pendant 5 min | non |
| `ConnexionsBaseSaturees` | P2 | > 80 % pendant 5 min | non |
| `DisqueBientotPlein` | P2 | < 15 % pendant 10 min | non |
| `PicDEchecsDeConnexion` | P2 | > 10/s pendant 2 min | non |
| `VirementsEnEchec` | P2 | ≥ 1 pendant 10 min | non |
| `SauvegardeManquante` | P2 | > 90 min sans sauvegarde | non |
| `CertificatTlsBientotExpire` | P3 | < 14 jours | non |
| `TestDeRestaurationEnRetard` | P3 | > 35 jours | non |

**Règle appliquée : peu d'alertes, toutes actionnables.** Chacune porte l'action
attendue et un renvoi vers le manuel d'exploitation. Une alerte qui ne dit pas
quoi faire finit par être ignorée — et une alerte ignorée équivaut à l'absence
d'alerte, en plus coûteuse.

---

## 4. Les quatre signaux d'or

Le système audité n'exposait **aucune métrique**. La seule information
disponible était une sonde qui répondait 200 en toutes circonstances : il était
impossible de savoir si la plateforme ralentissait, si le taux d'erreur montait
ou si un service saturait.

Chaque service expose désormais `/metrics` (voir `services/shared/src/metriques.js`).

| Signal | Métrique | Ce qu'elle révèle |
|---|---|---|
| **Latence** | `hrflow_duree_requete_secondes` | histogramme, centiles 50 / 95 / 99 par route |
| **Trafic** | `hrflow_requetes_total` | requêtes par seconde, par service et par route |
| **Erreurs** | `hrflow_requetes_total{statut=~"5.."}` | part des réponses en échec |
| **Saturation** | `nodejs_process_*`, `nodejs_nodejs_eventloop_*` | CPU, mémoire résidente, retard de la boucle d'événements |

**Un histogramme, pas une moyenne.** Une moyenne de latence masque exactement ce
qu'on cherche : une réponse sur cent à trois secondes ne la déplace pas, mais
c'est celle que l'utilisateur remarque.

**Les routes sont normalisées en gabarits.** `/conges/solde/10` et
`/conges/solde/11` alimentent une seule série `/conges/solde/:employeeId`. Sans
cette normalisation, 8 200 salariés produiraient 8 200 séries.

**`/metrics` n'est jamais public** : Nginx le restreint au réseau de
supervision, au même titre que la sonde de disponibilité.

Deux compteurs métier complètent l'ensemble, parce que deux alertes en dépendent :
`hrflow_connexions_echouees_total` (force brute) et
`hrflow_bulletins_paiement_en_echec` (virements non aboutis).

---

## 5. Tableau de bord

`monitoring/grafana/dashboards/hrflow-signaux-dor.json` — 14 panneaux, quatre
sections, une par signal.

| Section | Contenu |
|---|---|
| État de service | disponibilité sur 30 jours glissants, budget d'erreur consommé, services prêts, bulletins en échec |
| 1 · Latence | centiles 50/95/99, six routes les plus lentes |
| 2 · Trafic | requêtes par seconde et par service, répartition par route |
| 3 · Erreurs | taux de 5xx, réponses par classe de statut, échecs de connexion |
| 4 · Saturation | mémoire résidente, retard de la boucle d'événements, connexions PostgreSQL |

Deux panneaux méritent l'attention en soutenance :

- **Disponibilité sur 30 jours** — l'engagement contractuel est de 99,5 %
  mensuel auprès de 47 clients. Le panneau affiche l'écart à cet engagement.
- **Budget d'erreur consommé** — 0,5 % d'indisponibilité mensuelle représente
  3 h 39. L'incident du 14 août, à lui seul, en a consommé 85 %.

Le tableau de bord et sa source de données sont **provisionnés depuis le
dépôt** : aucune configuration manuelle dans l'interface. Une modification passe
par une demande de fusion, comme le code.

---

## 6. Routage des alertes

`monitoring/alertmanager.yml`.

| Gravité | Canal | Délai | Répétition |
|---|---|---|---|
| P1 | `#hrflow-astreinte` + `#hrflow-incidents` | 10 s | toutes les 15 min |
| P2 | `#hrflow-alertes` | 30 s | toutes les 12 h |
| P3 | `#hrflow-alertes` | 1 h | toutes les 72 h |

**Une P1 réveille quelqu'un, une P2 attend les heures ouvrées.** Confondre les
deux apprend à l'équipe à ignorer les notifications — et l'on retombe dans la
situation d'août 2024, en plus bruyant.

**Inhibitions.** Quand PostgreSQL tombe, les cinq services se déclarent non
prêts. Sans règle d'inhibition, l'astreinte reçoit six alertes pour un seul
incident et doit deviner laquelle est la cause. La panne de base masque donc les
indisponibilités de service, et une P1 masque les P2 du même service.

Chaque notification porte **l'action attendue** et un bouton vers le manuel
d'exploitation. Une alerte qui ne dit pas quoi faire finit par être ignorée.

---

## 7. Journalisation

Chaque service émet du JSON sur une ligne :

```json
{"ts":"2024-09-20T14:32:11.204Z","level":"info","service":"conges",
 "msg":"requête traitée","requestId":"7f3a…","method":"GET",
 "path":"/conges/solde/10","status":200,"durationMs":12.4,"userId":"55"}
```

Trois propriétés obligatoires :

- **structuré** — exploitable par un agrégateur, sans expression régulière ;
- **corrélé** — le même `requestId` traverse Nginx, la passerelle et le service ;
- **expurgé** — secrets remplacés, adresses e-mail masquées (`j***t@domaine`).

L'expurgation est appliquée par le journaliseur lui-même, pas par discipline des
développeurs. C'est ce qui empêche la répétition de SEC-10 (`JWT_SECRET`
journalisé au démarrage) et de SEC-03 (mot de passe réinitialisé écrit en clair
dans un journal accessible publiquement via `/logs/`).

**Rétention** : 30 jours en ligne, 12 mois archivés. Aucun journal n'est servi
par HTTP — le bloc Nginx `/logs/` a été supprimé.

---

## 8. Astreinte

| | |
|---|---|
| Rotation | hebdomadaire, deux personnes minimum |
| Périmètre | P1 uniquement, 24 h/24 |
| Canal | notification téléphonique, puis `#incidents` |
| Escalade | sans accusé de réception sous 10 min → seconde personne → direction technique |

**Conditions préalables**, sans lesquelles l'astreinte n'a pas de sens :

1. le manuel d'exploitation est à jour ;
2. la personne d'astreinte dispose des accès (serveurs, secrets, sauvegardes) ;
3. le retour arrière est testé et ne demande pas de diagnostic préalable.

Le troisième point est le plus important : la personne réveillée n'a pas besoin
de comprendre l'incident, elle a besoin de rétablir le service.

---

## 9. Mise en service

```bash
docker compose -f monitoring/docker-compose.monitoring.yml up -d
# Grafana : http://localhost:3001
```

### Vérification obligatoire — la panne provoquée

Une supervision jamais déclenchée est une hypothèse. En recette, on coupe un
service et on chronomètre :

```bash
docker compose -f docker/docker-compose.yml stop conges
# Attendu : ServiceIndisponible en moins de 2 minutes
docker compose -f docker/docker-compose.yml start conges
```

Le résultat de ce test est consigné : il constitue la preuve attendue par
l'exigence n°4 de l'audit Partech. À rejouer à chaque modification des sondes ou
des règles d'alerte.

---

## 10. Ce qui manque encore

| Sujet | Bénéfice | Condition |
|---|---|---|
| Métriques applicatives (`/metrics`) | taux d'erreur par route, durée des requêtes | instrumentation des services |
| Traçage distribué (OpenTelemetry) | suivre une requête à travers les services | supervision stabilisée |
| Tableau de bord métier | bulletins émis, congés en attente, virements en échec | métriques applicatives |
| Budget d'erreur et objectifs de service | arbitrer entre vitesse de livraison et stabilité | trois mois de mesures |

---

*Supervision HRFlow — à relire après chaque incident.*
