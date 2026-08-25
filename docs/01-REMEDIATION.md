# Suivi de remédiation — HRFlow

Ce document répond à une seule question, constat par constat : **où est la preuve
que c'est corrigé ?**

Une correction sans preuve vérifiable n'en est pas une. Le post-mortem du 14 août
listait cinq actions décidées ; dix jours plus tard, aucune n'était faite, et
rien dans le système ne l'aurait signalé. Chaque ligne ci-dessous renvoie donc
soit à un test qui échouerait si la vulnérabilité se rouvrait, soit à une
vérification exécutée par le pipeline.

**Légende du statut**
✅ corrigé et vérifié automatiquement · 🟩 corrigé, vérification manuelle ·
🟨 partiellement traité · ⬜ non traité, planifié · ➖ hors périmètre technique

---

## Tableau de bord

| Domaine | Total | ✅ | 🟩 | 🟨 | ⬜ | ➖ |
|---|---|---|---|---|---|---|
| Sécurité | 21 | 15 | 4 | 1 | 1 | 0 |
| Qualité | 14 | 11 | 1 | 2 | 0 | 0 |
| CI/CD | 10 | 7 | 3 | 0 | 0 | 0 |
| Infrastructure | 10 | 3 | 5 | 1 | 0 | 1 |
| Documentation | 6 | 1 | 5 | 0 | 0 | 0 |
| **Total** | **61** | **37** | **18** | **4** | **1** | **1** |

> Le total passe de 51 à 61 : les constats regroupés dans le rapport d'audit
> (SEC-18/19/21) sont suivis ici individuellement.

**Les 12 constats critiques sont tous fermés.**

---

## Sécurité

| ID | Statut | Correction | Preuve |
|---|---|---|---|
| SEC-01 | ✅ | `.env` retiré du suivi Git, `.gitignore` corrigé, `.env.example` créé, détection de secrets dans le pipeline | étape 3 du pipeline (gitleaks) ; `scripts/verify-security-fixes.sh` |
| SEC-02 | ✅ | Toutes les requêtes paramétrées ; validation des entrées en amont | `auth.test.js` « utilise une requête paramétrée » ; vérification d'absence d'interpolation |
| SEC-03 | ✅ | Parcours de réinitialisation réécrit : jeton à usage unique haché, expiration 30 min, envoi par courriel, réponse indifférenciée | `auth.test.js` § « prise de contrôle de compte » — 9 tests |
| SEC-04 | ✅ | Route `POST /paie/migrate` supprimée ; migrations en fichiers versionnés appliqués hors trafic | `paie/routes.test.js` « la route de migration a disparu » ; test de fumée |
| SEC-05 | ✅ | Route `GET /conges/debug/all` supprimée, non remplacée | `conges/routes.test.js` § SEC-05 ; test de fumée |
| SEC-06 | ✅ | Authentification réactivée sur la passerelle **et** vérifiée par chaque service | `gateway.test.js` § SEC-06 ; 5 tests par service |
| SEC-07 | ✅ | Type MIME en liste blanche, taille limitée à 5 Mo, signature binaire vérifiée, nom régénéré, stockage hors arborescence web | `recrutement/uploads.test.js` — 12 tests |
| SEC-08 | ✅ | `requireRole`, `requireSelfOrRole`, `companyScope` ; filtrage par entreprise dans chaque requête | tests d'autorisation des 4 services |
| SEC-09 | ✅ | Aucune valeur de repli ; refus de démarrer si une variable manque | `shared/securite.test.js` § config ; vérification de motifs interdits |
| SEC-10 | ✅ | Expurgation automatique du journaliseur ; configuration journalisée masquée | `shared/securite.test.js` « ne laisse jamais passer un secret » |
| SEC-11 | ✅ | Liste d'origines explicite, `*` impossible | `shared/infrastructure.test.js` § CORS ; test de fumée |
| SEC-12 | ✅ | Gestionnaire d'erreurs sans divulgation ; trace conservée côté serveur | `shared/securite.test.js` ; `gateway.test.js` ; test de fumée |
| SEC-13 | ✅ | Limitation de débit par IP + verrouillage de compte après 5 échecs | `auth.test.js` § énumération et force brute — 5 tests |
| SEC-14 | 🟩 | TLS 1.2/1.3, redirection HTTP, HSTS avec preload | `nginx/hrflow.conf` — à vérifier au déploiement |
| SEC-15 | ✅ | Bloc `/logs/` supprimé et explicitement refusé | vérification d'absence d'`autoindex` |
| SEC-16 | 🟩 | Staging authentifié, restreint par IP, `noindex` | `nginx/hrflow.conf` |
| SEC-17 | ✅ | En-têtes posés par l'application (helmet) **et** par Nginx | `shared/infrastructure.test.js` ; test de fumée |
| SEC-18 | ✅ | Jeton conservé en mémoire, plus aucun stockage navigateur | `frontend/login.test.jsx` « ni dans localStorage » |
| SEC-19 | ✅ | `jsonwebtoken` 9.x ; algorithme, émetteur et audience contraints | `shared/securite.test.js` « refuse un jeton `alg: none` » |
| SEC-20 | 🟨 | Adresses masquées dans les journaux ; politique de rétention à formaliser | `shared/securite.test.js` § logger |
| SEC-21 | ✅ | Jeton d'accès de 15 min, renouvellement révocable, révocation à la déconnexion et au changement de mot de passe | `auth.test.js` § refresh et logout |

**Reste ouvert** — ⬜ Rotation effective des secrets de production et purge de
l'historique Git. Procédure écrite (`docs/RUNBOOK.md` § 6.1) mais l'exécution
nécessite les accès de production et une coordination d'équipe : c'est la
première action de la mise en œuvre réelle, pas une tâche de développement.

---

## Qualité logicielle

| ID | Statut | Correction | Preuve |
|---|---|---|---|
| QUA-01 | ✅ | `asyncHandler` sur toutes les routes, filets au niveau du processus | `shared/securite.test.js` § asyncHandler ; `auth.test.js` « corps vide » |
| QUA-02 | 🟨 | Calcul en centimes entiers, arrondis corrects, barème sorti du code et daté ; temps partiel **refusé** au lieu d'être calculé faux | `paie/domain.test.js` — 13 tests. Validation du barème par un expert-comptable : hors compétence de l'équipe |
| QUA-03 | ✅ | Clé d'idempotence déterministe, échec persisté et remonté, route de rejeu | `paie/routes.test.js` § échec de virement |
| QUA-04 | ✅ | `withTransaction` ; contrainte d'unicité en base | `shared/infrastructure.test.js` ; `conges/routes.test.js` « ouvre une transaction » |
| QUA-05 | ✅ | Jours ouvrés bornes incluses, week-ends et fériés exclus, dates inversées refusées, chevauchement et solde contrôlés, contrainte en base | `conges/domain.test.js` — 11 tests |
| QUA-06 | ✅ | 232 tests de service, 3 tests d'interface, couverture > 80 % partout | rapports de couverture, étape 2 du pipeline |
| QUA-07 | ✅ | `npm test` exécute réellement les tests des six services | vérification explicite dans `verify-security-fixes.sh` |
| QUA-08 | ✅ | `package-lock.json` versionné, `npm ci` partout | vérification de présence du fichier de verrouillage |
| QUA-09 | ✅ | Frontend migré sur Vite, point d'entrée créé, build fonctionnel | `npm run build` — 71 modules, artefact produit |
| QUA-10 | ✅ | Répertoires vides et dépendances inutilisées supprimés ; `react-router-dom` retiré | `npm audit` : 0 vulnérabilité |
| QUA-11 | ✅ | Pagination avec plafond sur les trois listes | `recrutement/routes.test.js` § pagination |
| QUA-12 | ✅ | Trois requêtes remplacées par une agrégation ; index dédiés | `conges/routes.test.js` ; `db/migrations/001` |
| QUA-13 | 🟩 | ESLint, Prettier, versions alignées (3.0.0 / 2.0.0) | `npm run lint` et `npm run format` en étape 1 |
| QUA-14 | ✅ | Journalisation JSON structurée avec identifiant de corrélation propagé | `shared/securite.test.js` ; `gateway.test.js` § propagation |

---

## Chaîne d'intégration et de déploiement

| ID | Statut | Correction | Preuve |
|---|---|---|---|
| CIC-01 | ✅ | Cinq étapes, barrières bloquantes, approbation avant production | `.github/workflows/pipeline.yml` |
| CIC-02 | ✅ | Seule `main` atteint le déploiement ; `develop` s'arrête aux étapes 1 à 3 | condition `github.ref == 'refs/heads/main'` |
| CIC-03 | ✅ | Étape de test réactivée et bloquante | étape 2 |
| CIC-04 | 🟩 | Clé SSH et empreinte d'hôte connue ; plus aucun mot de passe | étapes 4 et 5 |
| CIC-05 | ✅ | Aucune action tierce ; actions officielles épinglées ; outils via images versionnées | `pipeline.yml` |
| CIC-06 | ✅ | Images immuables taguées par empreinte de commit, publiées au registre | étape 1 ; `scripts/deploy.sh` |
| CIC-07 | ✅ | Node 20, `actions/checkout@v4`, `actions/setup-node@v4` | `pipeline.yml` |
| CIC-08 | ✅ | Détection de secrets, audit de dépendances, analyse statique, non-régression | étape 3 |
| CIC-09 | 🟩 | Environnements GitHub, approbation obligatoire, contrôle de concurrence | `pipeline.yml` ; protection de branche à activer côté GitHub |
| CIC-10 | ✅ | Version = empreinte de commit, tracée dans l'image, l'API et le serveur | `/health/live` renvoie la version |

---

## Infrastructure

| ID | Statut | Correction | Preuve |
|---|---|---|---|
| INF-01 | ✅ | `/health/live` et `/health/ready` distincts, sondes réelles, agrégation à la passerelle | `gateway.test.js` § sonde agrégée ; supervision |
| INF-02 | 🟩 | Sauvegarde avant chaque déploiement, sauvegardes horaires, vérification d'intégrité, copie hors machine, test de restauration mensuel | `scripts/backup.sh` ; `docs/RUNBOOK.md` § 7 |
| INF-03 | ✅ | Procédure de retour arrière scriptée et déclenchée automatiquement en cas d'échec | `scripts/rollback.sh` ; étape 5 |
| INF-04 | ✅ | Clé SSH, empreinte d'hôte vérifiée, plus de `sshpass` | vérification de motifs interdits |
| INF-05 | ✅ | Environnement contrôlé et obligatoire ; hôte injecté ; garde-fou sur la production | `scripts/deploy.sh` § contrôles préalables |
| INF-06 | 🟩 | Bascule service par service avec attente de disponibilité ; arrêt progressif sur SIGTERM | `scripts/deploy.sh` ; `shared/bootstrap.js` |
| INF-07 | 🟩 | Staging authentifié, restreint, base distincte | `nginx/hrflow.conf` ; `docker/docker-compose.yml` |
| INF-08 | ✅ | Six services conteneurisés, sans privilèges, système de fichiers en lecture seule, limites mémoire | `docker/` |
| INF-09 | 🟨 | Limites de taille et délais posés côté Nginx et côté application ; quotas serveur à définir | `nginx/hrflow.conf` ; `shared/http.js` |
| INF-10 | ➖ | README opérationnel, manuel d'exploitation, architecture documentée : la connaissance n'est plus détenue par une seule personne | ensemble de `docs/` |

---

## Documentation

| ID | Statut | Livrable |
|---|---|---|
| DOC-01 | 🟩 | `README.md` — démarrage en trois commandes, sans dépendre de personne |
| DOC-02 | 🟩 | `docs/RUNBOOK.md` — incident, retour arrière, restauration, obligations RGPD |
| DOC-03 | 🟩 | `docs/architecture.md` — schémas, flux, choix |
| DOC-04 | 🟩 | `docs/openapi.yaml` — contrats des 16 routes |
| DOC-05 | 🟩 | `docs/ADR.md` — journal des décisions |
| DOC-06 | ✅ | Rétention des candidatures en base, procédure de purge documentée |

---

## Ce qui reste, et pourquoi

| Sujet | Nature | Décideur |
|---|---|---|
| Rotation des secrets de production, purge de l'historique | opérationnel, exige les accès de production | direction technique |
| Validation du barème de cotisations | comptable et juridique | expert-comptable |
| Sort des bulletins déjà émis avec un calcul erroné | juridique | direction générale |
| Protection de branche, relecteurs obligatoires | configuration GitHub | administrateur du dépôt |
| Certificats TLS et empreintes d'hôtes | opérationnel | administrateur système |

Ces points ne sont pas des oublis : ce sont des décisions qui n'appartiennent pas
à l'équipe technique, ou des actes qui exigent des accès dont un dépôt de code ne
dispose pas. Les signaler explicitement fait partie du travail.

---

*Suivi de remédiation — à mettre à jour à chaque constat traité.*
