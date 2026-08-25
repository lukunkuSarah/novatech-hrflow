# Manuel d'exploitation — HRFlow

> Ce document n'existait pas. Le 15 août 2024 à 2 h 25 du matin, la procédure de
> retour arrière consistait en : *« Théo tente un rollback manuel. Pas de
> procédure documentée. »* L'incident a duré 3 h 07.
>
> Ce manuel est écrit pour être lisible par quelqu'un qui vient d'être réveillé,
> qui n'a pas écrit le code, et qui n'a personne à appeler.

---

## 0. Les cinq premières minutes

| Situation | Aller directement à |
|---|---|
| La plateforme ne répond plus | [§ 2 — Coupure totale](#2--coupure-totale-p1) |
| Un déploiement vient de mal tourner | [§ 3 — Retour arrière](#3--retour-arrière) |
| Les données semblent corrompues | [§ 4 — Restauration](#4--restauration-de-données) |
| Un service est lent ou instable | [§ 5 — Dégradation](#5--dégradation-de-service) |
| Suspicion de compromission | [§ 6 — Incident de sécurité](#6--incident-de-sécurité) |

**Trois réflexes, dans cet ordre :**

1. **Constater** — `curl -s https://hrflow.novatech.io/health/ready | jq`
2. **Communiquer** — prévenir sur `#incidents` *avant* d'agir. Un incident connu
   coûte moins cher qu'un incident découvert par un client à 2 h 15 du matin.
3. **Rétablir d'abord, comprendre ensuite.** Le retour arrière n'a pas besoin
   d'un diagnostic. Il prend moins de deux minutes. Utilisez-le.

---

## 1. Repères

### Niveaux de gravité

| Niveau | Définition | Délai de réaction | Qui |
|---|---|---|---|
| **P1** | Plateforme indisponible ou données exposées | immédiat, 24 h/24 | astreinte + direction technique |
| **P2** | Une fonction majeure hors service (paie, connexion) | 30 min en heures ouvrées | astreinte |
| **P3** | Fonction dégradée, contournement existant | jour ouvré suivant | équipe |
| **P4** | Anomalie mineure | prochain sprint | équipe |

### Objectifs de rétablissement

| Indicateur | Constaté lors du P1 | Objectif | Moyen |
|---|---|---|---|
| Détection (MTTD) | 2 h 28 | < 2 min | alerte automatique sur `/health/ready` |
| Rétablissement (MTTR) | 3 h 07 | < 10 min | `scripts/rollback.sh` |
| Perte de données (RPO) | 1 h 17 | < 15 min | sauvegardes horaires + journalisation continue |

### Accès nécessaires

| Ressource | Où |
|---|---|
| Serveurs | `ssh deploy@<hôte>`, clé personnelle dans le gestionnaire de secrets |
| Secrets | AWS Secrets Manager, dossier `hrflow/production` |
| Registre d'images | `ghcr.io`, jeton dans le gestionnaire de secrets |
| Sauvegardes | `s3://novatech-hrflow-backups/production/` |
| Supervision | tableau de bord `hrflow-production` |

---

## 2. Coupure totale (P1)

### 2.1 Constater

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://hrflow.novatech.io/health/live
curl -s https://hrflow.novatech.io/health/ready | jq '.dependencies'
```

La réponse de `/health/ready` désigne le service fautif. C'est précisément ce
qui manquait en août 2024 : l'ancienne sonde répondait 200 quoi qu'il arrive.

```bash
ssh deploy@<hôte> 'cd /opt/hrflow && docker compose ps'
ssh deploy@<hôte> 'cd /opt/hrflow && docker compose logs --tail=200 --since=15m'
```

### 2.2 Décider

```
Un déploiement a-t-il eu lieu dans les 30 dernières minutes ?
├── OUI  → § 3 Retour arrière.  Ne cherchez pas la cause d'abord.
└── NON  → La base répond-elle ?
          ├── NON → § 2.3 Base indisponible
          └── OUI → § 5 Dégradation de service
```

### 2.3 Base indisponible

```bash
ssh deploy@<hôte> 'cd /opt/hrflow && docker compose exec -T postgres pg_isready -U hrflow'

# Saturation disque : cause la plus fréquente
ssh deploy@<hôte> 'df -h /var/lib/docker /var/backups'

# Connexions saturées
ssh deploy@<hôte> "cd /opt/hrflow && docker compose exec -T postgres \
  psql -U hrflow -d hrflow -c 'SELECT count(*), state FROM pg_stat_activity GROUP BY state'"
```

Si le disque est plein, les sauvegardes locales sont purgeables sans risque
(elles sont répliquées sur S3) :

```bash
ssh deploy@<hôte> "find /var/backups/hrflow -name '*.dump' -mtime +1 -delete"
```

### 2.4 Communiquer

Message type, à publier dès la constatation, pas après résolution :

> **[P1 en cours]** HRFlow est indisponible depuis HH:MM. Cause en cours de
> qualification. Prochaine mise à jour dans 15 minutes.
> Suivi : `#incidents`.

---

## 3. Retour arrière

> **Objectif : moins de 2 minutes.** Le retour arrière n'exige aucun diagnostic
> préalable. En cas de doute après un déploiement, revenez en arrière.

```bash
export HOTE=<hôte-production>
bash scripts/rollback.sh production
```

Vers une version précise :

```bash
bash scripts/rollback.sh production a1b2c3d
```

Versions disponibles sur le serveur :

```bash
ssh deploy@$HOTE "docker image ls --format '{{.Repository}}:{{.Tag}}' | grep hrflow"
```

### Vérification

```bash
BASE_URL=https://hrflow.novatech.io npm run smoke
```

### Ce que le retour arrière ne fait pas

Il ramène **le code**, pas **les données**. Une migration destructive ne se
rattrape pas ainsi — voir § 4.

C'est pour cette raison que les migrations sont écrites de façon compatible avec
la version précédente : on ajoute une colonne avant de l'utiliser, on ne la
supprime qu'au déploiement suivant. Une migration qui casse la version
précédente rend le retour arrière impossible, ce qui revient à supprimer le
filet de sécurité.

---

## 4. Restauration de données

> À n'employer que si les données sont réellement corrompues ou perdues. Une
> restauration fait perdre tout ce qui a été écrit depuis la sauvegarde.

### 4.1 Décision

Cette décision appartient à la direction technique. Consignez avant d'agir :

- l'heure estimée de la corruption ;
- la sauvegarde retenue ;
- la perte de données acceptée, en minutes.

### 4.2 Procédure

```bash
# 1. Interrompre les écritures
ssh deploy@$HOTE 'cd /opt/hrflow && docker compose stop api-gateway auth paie conges recrutement'

# 2. Sauvegarder l'état corrompu — il servira à l'analyse post-incident
HOTE=$HOTE bash scripts/backup.sh production avant-restauration

# 3. Récupérer la sauvegarde retenue
ssh deploy@$HOTE 'aws s3 ls s3://novatech-hrflow-backups/production/ | tail -20'
ssh deploy@$HOTE 'aws s3 cp s3://novatech-hrflow-backups/production/<archive>.dump /tmp/'

# 4. Restaurer
ssh deploy@$HOTE "cd /opt/hrflow && docker compose exec -T postgres \
  pg_restore --clean --if-exists --no-owner -U hrflow -d hrflow < /tmp/<archive>.dump"

# 5. Vérifier avant de rouvrir
ssh deploy@$HOTE "cd /opt/hrflow && docker compose exec -T postgres psql -U hrflow -d hrflow -c \
  'SELECT (SELECT count(*) FROM employees) AS salaries, \
          (SELECT count(*) FROM conges) AS conges, \
          (SELECT count(*) FROM bulletins_paie) AS bulletins'"

# 6. Redémarrer
ssh deploy@$HOTE 'cd /opt/hrflow && docker compose up -d'
BASE_URL=https://hrflow.novatech.io npm run smoke
```

### 4.3 Après une restauration

Une perte de données sur des bulletins de paie ou des congés validés a des
conséquences juridiques. Prévenir dans l'ordre : direction technique, direction
générale, puis — si des données personnelles sont concernées — le délégué à la
protection des données, **dans les 72 heures** (RGPD, article 33).

---

## 5. Dégradation de service

```bash
# Quel service est en cause
curl -s https://hrflow.novatech.io/health/ready | jq '.dependencies[] | select(.status=="down")'

# Consommation
ssh deploy@$HOTE 'docker stats --no-stream'

# Requêtes lentes
ssh deploy@$HOTE "cd /opt/hrflow && docker compose exec -T postgres psql -U hrflow -d hrflow -c \
  \"SELECT pid, now()-query_start AS duree, left(query,80) FROM pg_stat_activity \
    WHERE state='active' AND now()-query_start > interval '5 seconds' ORDER BY duree DESC\""
```

Redémarrage d'un seul service, sans toucher aux autres :

```bash
ssh deploy@$HOTE 'cd /opt/hrflow && docker compose up -d --no-deps --wait conges'
```

> À ne pas faire : `docker compose restart` sans argument, équivalent du
> `pm2 restart all` d'origine — il coupe toute la plateforme pour réparer un
> seul service.

### Rejeu des virements en échec

Depuis la correction de QUA-03, un ordre de virement en échec n'est plus avalé
en silence : le bulletin porte l'état `paiement_a_rejouer`.

```bash
ssh deploy@$HOTE "cd /opt/hrflow && docker compose exec -T postgres psql -U hrflow -d hrflow -c \
  \"SELECT id, employee_id, periode_reference, statut FROM bulletins_paie \
    WHERE statut IN ('paiement_a_rejouer','paiement_en_echec')\""
```

Le rejeu s'appuie sur la clé d'idempotence : il ne peut pas payer deux fois.

```bash
curl -X POST https://hrflow.novatech.io/api/paie/bulletins/<id>/rejouer-paiement \
  -H "Authorization: Bearer <jeton-rh>"
```

---

## 6. Incident de sécurité

### 6.1 Fuite de secret

Un secret publié est un secret compromis, y compris s'il est immédiatement
retiré. On ne le retire pas : on le révoque.

```bash
# 1. Révoquer, dans cet ordre de gravité
#    Stripe (clé live) → AWS → JWT_SECRET → base de données → SendGrid → SMTP
# 2. Générer les remplaçants
openssl rand -hex 48
# 3. Publier dans le gestionnaire de secrets, puis redéployer
# 4. Invalider toutes les sessions : la rotation du JWT_SECRET y suffit
# 5. Rechercher un usage frauduleux : CloudTrail, journal Stripe, connexions BDD
```

Retirer un secret de l'historique Git (**après** révocation, jamais à la place) :

```bash
git filter-repo --path .env --invert-paths
# Nécessite une réécriture coordonnée : prévenir toute l'équipe avant.
```

### 6.2 Accès non autorisé suspecté

```bash
# Connexions réussies récentes
ssh deploy@$HOTE "cd /opt/hrflow && docker compose logs auth --since=24h | grep 'connexion réussie'"

# Comptes verrouillés — signe d'une attaque par force brute
ssh deploy@$HOTE "cd /opt/hrflow && docker compose exec -T postgres psql -U hrflow -d hrflow -c \
  'SELECT id, failed_attempts, locked_until FROM users WHERE failed_attempts > 0'"

# Révoquer toutes les sessions d'un compte
ssh deploy@$HOTE "cd /opt/hrflow && docker compose exec -T postgres psql -U hrflow -d hrflow -c \
  'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = <id> AND revoked_at IS NULL'"
```

### 6.3 Obligations RGPD

En cas de violation de données personnelles : notification à la CNIL sous
**72 heures**, information des personnes concernées si le risque est élevé.
Déclencheur, pas option. Contact : délégué à la protection des données.

---

## 7. Opérations courantes

### Sauvegarde manuelle

```bash
HOTE=<hôte> bash scripts/backup.sh production avant-intervention
```

### Test de restauration — mensuel, obligatoire

> Une sauvegarde jamais restaurée est une hypothèse, pas une sauvegarde. Aucun
> test de restauration n'avait été fait depuis la création du système (INF-02).

```bash
# Sur un environnement jetable, jamais en production
docker compose -f docker/docker-compose.yml up -d postgres
docker compose -f docker/docker-compose.yml exec -T postgres \
  pg_restore --clean --no-owner -U hrflow -d hrflow < <archive>.dump
# Vérifier les volumétries, puis consigner la date et la durée du test
```

### Appliquer une migration

```bash
# Toujours sur staging d'abord, sauvegarde prise ensuite, production enfin
ssh deploy@$HOTE 'cd /opt/hrflow && docker compose run --rm migrate node db/migrate.js status'
HOTE=$HOTE bash scripts/backup.sh production avant-migration
ssh deploy@$HOTE 'cd /opt/hrflow && docker compose run --rm migrate node db/migrate.js up'
```

Jamais via une requête HTTP. La route `POST /paie/migrate` a été supprimée : elle
est la cause directe de l'incident du 14 août.

### Purge RGPD des candidatures échues

```bash
ssh deploy@$HOTE "cd /opt/hrflow && docker compose exec -T postgres psql -U hrflow -d hrflow -c \
  'DELETE FROM candidats WHERE purge_prevue_le < CURRENT_DATE'"
# Les CV correspondants sont supprimés par la tâche planifiée associée.
```

---

## 8. Après l'incident

Un post-mortem est rédigé dans les 48 heures pour tout P1 ou P2, et publié à
toute l'équipe.

| Section | Contenu |
|---|---|
| Chronologie | horodatée, y compris les fausses pistes |
| Impact | utilisateurs, données, durée, clients affectés |
| Causes racines | techniques **et** processuelles |
| Ce qui a fonctionné | à préserver explicitement |
| Actions correctives | avec un responsable et une date |

**Deux règles.**

Le post-mortem ne cherche pas de responsable individuel. La question n'est pas
« qui a lancé la migration », mais « pourquoi était-il possible de lancer une
migration en production depuis une requête HTTP anonyme ».

Une action corrective sans responsable ni date n'est pas une action corrective.
Le post-mortem du 14 août listait cinq actions décidées. Dix jours plus tard,
son auteur écrivait : *« Status : aucune action réalisée à ce jour »*. Aucune
n'avait de responsable ni d'échéance.

---

*Manuel d'exploitation HRFlow — à relire à chaque post-mortem.*
