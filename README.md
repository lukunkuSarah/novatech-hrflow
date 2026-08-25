# HRFlow — Plateforme RH SaaS

Plateforme de gestion des ressources humaines pour les PME françaises : paie, congés, recrutement.
8 200 utilisateurs, 4 services métier derrière une passerelle d'API.

> **État du projet.** Ce dépôt est en cours de remédiation à la suite de l'audit technique
> de septembre 2024. L'avancement est suivi dans [docs/00-AUDIT-J1.md](docs/00-AUDIT-J1.md)
> et [docs/01-REMEDIATION.md](docs/01-REMEDIATION.md).

---

## Démarrage rapide

Prérequis : Docker Desktop et Node.js 20 ou supérieur.

```bash
git clone git@github.com:lukunkuSarah/novatech-hrflow.git && cd novatech-hrflow
cp .env.example .env
```

Renseignez au minimum ces trois variables dans `.env` :

```bash
# Génération d'un secret de signature
openssl rand -hex 48        # → JWT_SECRET
```

| Variable | Valeur locale |
|---|---|
| `JWT_SECRET` | la sortie de la commande ci-dessus |
| `DB_PASSWORD` | ce que vous voulez, par exemple `motdepasse-local` |
| `STRIPE_SECRET_KEY` | une clé de test `sk_test_...`, ou `sk_test_factice` en local |

Puis :

```bash
docker compose -f docker/docker-compose.yml up --build
```

| Service | Adresse |
|---|---|
| Interface web | http://localhost:8080 |
| API (passerelle) | http://localhost:3000 |
| Sonde de disponibilité | http://localhost:3000/health/ready |

Chargement du jeu de démonstration :

```bash
docker compose -f docker/docker-compose.yml exec -T postgres psql -U hrflow -d hrflow < db/seed.sql
```

Comptes de démonstration (mot de passe commun : `DemoHRFlow2024!`) :

| Adresse | Rôle | Entreprise |
|---|---|---|
| `karim.bouaziz@mercure.example` | admin | Atelier Mercure |
| `camille.lefevre@mercure.example` | rh | Atelier Mercure |
| `mohamed.alrashid@mercure.example` | salarié | Atelier Mercure |
| `yuki.nakamura@lumen.example` | rh | Groupe Lumen |

Les deux entreprises existent pour pouvoir vérifier le cloisonnement : un compte
d'Atelier Mercure ne doit voir aucune donnée de Groupe Lumen.

---

## Développement sans Docker

```bash
npm ci                 # installation reproductible depuis le fichier de verrouillage
npm test               # tests des services, couverture bloquante à 80 %
npm run test:frontend  # tests de l'interface
npm run lint           # analyse statique
npm run build          # construction du frontend
```

Chaque service se lance individuellement :

```bash
npm run dev --workspace=services/auth
```

Un service refuse de démarrer si une variable requise est absente. C'est
volontaire : un service qui démarre avec un secret par défaut est un service
compromis qui s'ignore (constat SEC-09).

---

## Architecture

```
Navigateur
    │
    ▼
Nginx (TLS, limitation de débit, en-têtes de sécurité)
    │
    ▼
API Gateway :3000  ── authentification, corrélation, agrégation des sondes
    │
    ├──▶ auth        :3001   connexion, jetons, réinitialisation
    ├──▶ paie        :3002   bulletins, ordres de virement
    ├──▶ conges      :3003   soldes, demandes, validations
    └──▶ recrutement :3004   candidatures, CV
                │
                ▼
        PostgreSQL 16
```

Les quatre services métier ne sont pas exposés publiquement : seule la
passerelle l'est. Chacun revérifie néanmoins l'authentification pour son propre
compte — l'incident d'origine vient précisément de l'hypothèse inverse.

Détail complet : [docs/architecture.md](docs/architecture.md).
Contrats d'interface : [docs/openapi.yaml](docs/openapi.yaml).

---

## Tests

| Périmètre | Tests | Couverture |
|---|---|---|
| `services/shared` | 93 | 95 % |
| `services/auth` | 34 | 99 % |
| `services/paie` | 47 | 98 % |
| `services/conges` | 38 | 99 % |
| `services/recrutement` | 33 | 96 % |
| `services/api-gateway` | 23 | 100 % |
| `frontend` | 3 unitaires + 8 parcours E2E | — |

```bash
npm run test:all       # services + interface + parcours de bout en bout
```

Le seuil de 80 % est **bloquant** : il est défini dans le `jest.config.js` de
chaque service et fait échouer le pipeline s'il n'est pas atteint.

Une part importante de ces tests sont des tests de non-régression de sécurité :
ils vérifient qu'une vulnérabilité fermée ne peut pas se rouvrir. Par exemple,
`services/paie/__tests__/routes.test.js` vérifie que `POST /paie/migrate`
répond 404 — c'est la route qui a provoqué l'incident du 14 août 2024.

---

## Déploiement

Aucun déploiement ne se fait à la main. Le pipeline
[.github/workflows/pipeline.yml](.github/workflows/pipeline.yml) comporte cinq étapes :

| Étape | Contenu | Bloquant |
|---|---|---|
| 1 · Build | `npm ci`, lint, formatage, build, images immuables taguées par empreinte de commit | oui |
| 2 · Test | tests unitaires et d'intégration, couverture ≥ 80 % | oui |
| 3 · Security | détection de secrets, audit des dépendances, analyse statique, non-régression | oui |
| 4 · Deploy staging | déploiement automatique, migrations, tests de fumée | oui |
| 5 · Deploy production | approbation manuelle, bascule sans interruption, retour arrière automatique | — |

- `main` est protégée : aucun envoi direct, fusion par demande de fusion uniquement.
- La branche `develop` ne peut pas atteindre la production.
- Le déploiement en production exige l'approbation d'une personne habilitée.

Retour arrière :

```bash
HOTE=<serveur> bash scripts/rollback.sh production
```

Procédure complète, y compris restauration de données : [docs/RUNBOOK.md](docs/RUNBOOK.md).

---

## Sécurité

Le rapport d'audit recense 51 constats, dont 12 non identifiés par l'audit externe.
Suivi de leur traitement : [docs/01-REMEDIATION.md](docs/01-REMEDIATION.md).

Points de vigilance permanents :

- **Aucun secret dans le dépôt.** `.env` est ignoré par Git, et le pipeline échoue
  si un secret est détecté dans le code ou l'historique.
- **Aucune valeur de repli pour un secret.** Un service dont la configuration est
  incomplète refuse de démarrer.
- **Toutes les requêtes SQL sont paramétrées.** Le pipeline vérifie l'absence
  d'interpolation dans les requêtes.
- **Toutes les routes métier exigent un jeton** et un contrôle de rôle, et
  filtrent par entreprise cliente.

> **Réserve importante.** Les secrets d'origine sont toujours présents dans les
> premiers commits de l'historique. Le retrait du suivi ne les efface pas : ils
> doivent être **révoqués**, pas seulement retirés. Procédure :
> [docs/RUNBOOK.md](docs/RUNBOOK.md) § 6.1.

Signalement d'une vulnérabilité : `securite@novatech.io`.

---

## Supervision

```bash
docker compose -f monitoring/docker-compose.monitoring.yml up -d
```

| Service | Adresse |
|---|---|
| Grafana — les quatre signaux d'or | http://localhost:3001 |
| Prometheus | http://localhost:9090 |
| Alertmanager | http://localhost:9093 |

Le tableau de bord et la source de données sont **provisionnés depuis le
dépôt** : aucune configuration manuelle dans l'interface. Une modification passe
par une demande de fusion, comme le code.

Objectif de détection : **90 secondes**, contre 2 h 28 mesurées lors de
l'incident du 14 août. Détail : [docs/MONITORING.md](docs/MONITORING.md).

---

## Drapeaux de fonctionnalité

Un drapeau sépare deux décisions que le système audité confondait : **déployer**
du code et **activer** un comportement. Le code part en production éteint ; on
l'allume pour un client, puis pour dix pour cent, puis pour tous ; et on
l'éteint sans redéployer.

```bash
FEATURE_FLAGS='{"paie.temps-partiel":{"actif":true,"entreprises":[100]}}'
```

Le seul drapeau actif aujourd'hui, `paie.temps-partiel`, reste éteint tant que
le barème de cotisations n'est pas validé par un expert-comptable (ADR-005 et
ADR-007).

---

## Contribution

| Type de branche | Usage |
|---|---|
| `feature/*` | nouvelle fonctionnalité |
| `fix/*` | correction |
| `hotfix/*` | correction urgente en production |

Les messages de commit suivent la convention `type(portée) : description`
(`fix(auth) : requêtes paramétrées sur la connexion`).

Une demande de fusion n'est fusionnable que si les étapes 1 à 3 du pipeline sont
vertes et qu'une revue a été approuvée.

---

## Documentation

| Document | Contenu |
|---|---|
| [docs/00-AUDIT-J1.md](docs/00-AUDIT-J1.md) | Rapport d'audit : 51 constats, priorisation, plan |
| [docs/01-REMEDIATION.md](docs/01-REMEDIATION.md) | Suivi du traitement, constat par constat |
| [docs/architecture.md](docs/architecture.md) | Architecture détaillée et décisions |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Procédures d'incident, retour arrière, restauration |
| [docs/MONITORING.md](docs/MONITORING.md) | Supervision, alertes, astreinte |
| [docs/ADR.md](docs/ADR.md) | Journal des décisions d'architecture |
| [docs/openapi.yaml](docs/openapi.yaml) | Contrats d'interface des 16 routes |
| [docs/PLAN-DE-TESTS.md](docs/PLAN-DE-TESTS.md) | Stratégie de test, matrice de couverture, traçabilité constat → test |
| [docs/rapport/RAPPORT-HRFLOW.pdf](docs/rapport/RAPPORT-HRFLOW.pdf) | Rapport de remédiation, résumé exécutif en anglais inclus |
| [docs/soutenance/index.html](docs/soutenance/index.html) | Support de soutenance |
| [docs/incident-aout-2024.md](docs/incident-aout-2024.md) | Post-mortem de l'incident P1 |
| [docs/audit-partech-septembre-2024.md](docs/audit-partech-septembre-2024.md) | Audit externe |

---

*NovaTech SAS — Dernière mise à jour : voir l'historique Git de ce fichier.*
