# Plan de tests — NovaTech HRFlow

**Équipe BB_NUMERIQUE** · Livrable L2 · Bloc BC03

---

## 1. Pourquoi ce plan existe

Le système audité affichait **0 % de couverture** sur les quatre services métier, et
deux tests frontend réduits à `expect(true).toBe(true)`, accompagnés de ce
commentaire :

```js
expect(true).toBe(true) // test vide pour éviter l'erreur CI
```

L'étape de test du pipeline avait été commentée en janvier 2022, motif inscrit
dans le fichier : « les tests cassaient le pipeline ».

Ce plan ne vise donc pas seulement à atteindre un seuil de couverture. Il répond
à une question plus précise : **quels tests auraient empêché les incidents déjà
survenus ?** Chaque cas de test décrit ci-dessous est rattaché à un constat
d'audit ou à un incident daté.

---

## 2. Objectifs et critères d'acceptation

| Objectif | Mesure | Seuil | Bloquant |
|---|---|---|---|
| Couverture des services | instructions, branches, fonctions, lignes | ≥ 80 % par service | oui |
| Non-régression de sécurité | constats critiques couverts par un test | 12 / 12 | oui |
| Parcours utilisateur critiques | scénarios E2E verts | 5 / 5 | oui |
| Vulnérabilités de dépendances | `npm audit --audit-level=high` | 0 | oui |
| Motifs interdits | `scripts/verify-security-fixes.sh` | 14 / 14 | oui |
| Durée totale de la suite | temps d'exécution en intégration continue | < 5 min | non |

**Critère d'entrée** : le code compile, le lint passe, les dépendances sont
installées depuis le fichier de verrouillage.

**Critère de sortie** : les six seuils bloquants sont atteints. Aucune dérogation
n'est prévue — c'est précisément la dérogation de janvier 2022 qui a conduit à
l'état audité.

---

## 3. Stratégie : une pyramide, pas un empilement

```
                   ┌───────────────┐
                   │   E2E   5     │  parcours utilisateur, navigateur réel
                   └───────────────┘
              ┌─────────────────────────┐
              │   Intégration   ~120    │  route HTTP → autorisation → SQL
              └─────────────────────────┘
        ┌───────────────────────────────────────┐
        │        Unitaires   ~110               │  règles métier, utilitaires
        └───────────────────────────────────────┘
```

**Répartition retenue** : 235 tests, dont 5 E2E.

Le rapport est volontairement déséquilibré vers le bas. Un test E2E met dix
secondes à s'exécuter et échoue pour des raisons qui ne sont pas toujours
fonctionnelles — attente, réseau, rendu. Un test unitaire met quelques
millisecondes et pointe une ligne. Les défauts métier découverts pendant l'audit
— jours de congés négatifs, arrondis de paie, absence d'idempotence — se
vérifient tous au niveau unitaire, sans base de données et sans navigateur.

**Conséquence assumée** : la suite tourne **sans infrastructure**. Ni base, ni
réseau, ni conteneur. C'est ce qui la rend exécutable à chaque demande de fusion,
donc ce qui la rend crédible. Une suite qui exige une infrastructure finit par
être désactivée — c'est exactement ce qui s'est produit ici.

---

## 4. Typologie et outillage

| Niveau | Outil | Périmètre | Doublure |
|---|---|---|---|
| Unitaire | Jest 29 | règles métier pures, utilitaires transverses | aucune |
| Intégration | Jest + Supertest | route HTTP complète : validation, autorisation, SQL émis | pool PostgreSQL simulé (`fakePool`) |
| E2E | Playwright | parcours navigateur sur l'interface construite | API interceptée au niveau réseau |
| Sécurité | gitleaks, `npm audit`, Trivy | secrets, dépendances, système de fichiers | — |
| Non-régression | script maison | motifs interdits dans le code | — |

### Pourquoi un pool simulé plutôt qu'une base de test

`fakePool` (dans `@hrflow/shared`) répond au SQL reçu et **enregistre les
requêtes émises**. Cela permet de vérifier ce qu'aucune base réelle ne
permettrait d'affirmer aussi directement :

```js
const lecture = requetes.find((r) => /GROUP BY/.test(r.sql))
expect(lecture.sql).toContain('e.company_id = $2')   // cloisonnement présent
expect(lecture.params).toEqual(['10', '100'])        // valeurs paramétrées
expect(lecture.sql).not.toContain(email)             // aucune interpolation
```

Le test porte sur **la forme de la requête**, pas seulement sur son résultat.
C'est ce qui permet de garantir l'absence d'injection SQL (SEC-02) et la présence
du filtrage par entreprise (SEC-08) route par route.

---

## 5. Matrice de couverture par service

| Service | Tests | Instructions | Branches | Fonctions | Lignes |
|---|---|---|---|---|---|
| `shared` | 62 | 95,4 % | 80,0 % | 97,4 % | 97,2 % |
| `api-gateway` | 23 | 100 % | 82,4 % | 100 % | 100 % |
| `auth` | 34 | 99,0 % | 100 % | 93,8 % | 99,0 % |
| `paie` | 42 | 98,3 % | 95,9 % | 100 % | 100 % |
| `conges` | 38 | 99,1 % | 89,5 % | 93,3 % | 99,0 % |
| `recrutement` | 33 | 96,0 % | 83,3 % | 100 % | 95,7 % |
| `frontend` | 3 + 5 E2E | — | — | — | — |

Seuils déclarés dans le `jest.config.js` de chaque service. Un service qui passe
sous le seuil fait échouer l'étape 2 du pipeline.

### Ce qui n'est pas couvert, et pourquoi

| Exclusion | Motif |
|---|---|
| `src/index.js` de chaque service | point d'entrée : ouvre un port et se connecte à la base. Testé de fait par les tests de fumée post-déploiement. |
| `shared/src/bootstrap.js` | même raison : démarrage et arrêt du processus. |
| `shared/src/testing.js` | outillage de test, pas du code de production. |
| Branches d'erreur du client Stripe réel | le client est testé avec une fonction `fetch` injectée ; l'appel réseau réel relève des tests de fumée. |

---

## 6. Traçabilité : un test par constat critique

C'est la partie du plan qui répond à la question du jury *« qu'est-ce qui vous
garantit que ça ne se reproduira pas ? »*

| Constat | Test | Vérifie |
|---|---|---|
| SEC-02 injection SQL | `auth.test.js` — « utilise une requête paramétrée » | la valeur n'apparaît pas dans le texte SQL |
| SEC-03 prise de contrôle de compte | `auth.test.js` § réinitialisation — 9 tests | l'ancienne route répond 404 ; aucune écriture sur `users` sans jeton |
| SEC-04 migration par HTTP | `paie/routes.test.js` — « la route de migration a disparu » | 404, même avec un jeton administrateur |
| SEC-05 fuite RGPD | `conges/routes.test.js` § SEC-05 | 404, et aucune donnée dans la réponse |
| SEC-06 authentification désactivée | `gateway.test.js` — 3 routes testées | 401 sans jeton |
| SEC-07 téléversement non contrôlé | `recrutement/uploads.test.js` — 12 tests | signature binaire vérifiée ; nom de fichier régénéré |
| SEC-08 cloisonnement | tests d'autorisation des 4 services | 403 sur les données d'autrui ; `company_id` dans chaque requête |
| SEC-09 secrets en repli | `shared/securite.test.js` § config | refus de démarrer si un secret manque |
| SEC-10 secret journalisé | `shared/securite.test.js` — « ne laisse jamais passer un secret » | expurgation même imbriquée |
| SEC-12 trace exposée | `shared` + `gateway` | ni trace, ni message interne, ni adresse |
| SEC-13 force brute | `auth.test.js` § énumération — 5 tests | verrouillage au 5ᵉ échec ; message indifférencié |
| SEC-18 jeton persisté | `login.test.jsx` + E2E-03 | `localStorage` reste vide |
| SEC-19 algorithme non contraint | `shared/securite.test.js` | jeton `alg: none` refusé |
| QUA-01 arrêt du processus | `shared` + `auth` — corps vide | 400 au lieu d'un arrêt |
| QUA-02 calcul de paie | `paie/domain.test.js` — 13 tests | arrondis au centime ; temps partiel refusé |
| QUA-03 double virement | `paie/routes.test.js` | clé d'idempotence déterministe |
| QUA-05 fraude aux congés | `conges/domain.test.js` — 11 tests | dates inversées refusées ; fériés exclus |
| INF-01 sonde mensongère | `gateway.test.js` § sonde | 503 dès qu'un service tombe |

---

## 7. Scénarios de bout en bout

Cinq parcours, exécutés dans Chromium par Playwright sur le frontend **réellement
construit** (`vite build`), avec l'API interceptée au niveau réseau.

| # | Parcours | Vérifie | Rattachement |
|---|---|---|---|
| E2E-01 | Connexion réussie, affichage du solde | enchaînement formulaire → jeton → appel authentifié → rendu | parcours nominal |
| E2E-02 | Identifiants invalides | message indifférencié, aucune navigation | SEC-13 |
| E2E-03 | Aucun jeton persisté | `localStorage` et `sessionStorage` vides après connexion | SEC-18 |
| E2E-04 | Solde disponible et demandes en attente | le solde affiché déduit les demandes non validées | QUA-05 |
| E2E-05 | Panne du service | message d'erreur sans détail technique ni trace | SEC-12 |

### Pourquoi l'API est interceptée plutôt que réelle

Un test E2E qui dépend d'une base de données, de six conteneurs et d'un jeu de
données mesure autant l'infrastructure que l'application. Il devient instable, et
un test instable finit par être ignoré puis supprimé.

Ici, Playwright intercepte les requêtes réseau et répond selon **le contrat
d'interface décrit dans `docs/openapi.yaml`**. Le parcours navigateur est réel —
rendu, saisie, navigation, stockage — seule la source des données est maîtrisée.
La conformité de l'API réelle à ce contrat est vérifiée séparément, par les 120
tests d'intégration et par les tests de fumée exécutés après chaque déploiement.

**Limite assumée** : cette approche ne détecterait pas une divergence entre le
contrat et l'implémentation. C'est le rôle des tests de fumée
(`scripts/smoke-test.js`), qui interrogent l'environnement réellement déployé.

---

## 8. Données de test

| Environnement | Données | Origine |
|---|---|---|
| Unitaire et intégration | valeurs construites dans le test | aucune donnée réelle |
| E2E | réponses conformes à `docs/openapi.yaml` | interception réseau |
| Local et démonstration | `db/seed.sql` — 2 entreprises, 4 salariés | fictives |
| Staging | export anonymisé | production, anonymisée |

**Deux entreprises dans le jeu de démonstration**, et ce n'est pas décoratif :
c'est ce qui permet de démontrer le cloisonnement en tentant, depuis un compte
d'Atelier Mercure, d'accéder aux données de Groupe Lumen.

**Aucune donnée de production n'entre dans un test.** Le mot de passe commun du
jeu de démonstration est publié dans le README : il n'a de valeur que localement.

---

## 9. Exécution

| Contexte | Commande | Durée |
|---|---|---|
| Services | `npm test` | ≈ 60 s |
| Frontend | `npm run test:frontend` | ≈ 30 s |
| Bout en bout | `npm run test:e2e` | ≈ 30 s |
| Non-régression | `bash scripts/verify-security-fixes.sh` | < 5 s |
| Tout | `npm run test:all` | ≈ 2 min |

Dans le pipeline, l'étape 2 exécute l'ensemble et publie les rapports de
couverture en artefacts.

---

## 10. Tests instables

Un test qui échoue une fois sur dix est plus nuisible qu'un test absent : il
apprend à l'équipe à relancer le pipeline sans lire l'échec.

**Règle retenue** : aucune reprise automatique. Un test instable est corrigé dans
la journée, ou retiré et consigné comme dette dans `docs/01-REMEDIATION.md`. Il
n'est jamais laissé en place « en attendant ».

Sources d'instabilité écartées par construction : aucune base réelle, aucun
appel réseau sortant, aucune attente fixe (`waitForSelector` plutôt que
`waitForTimeout`), aucune dépendance à l'horloge — sauf dates explicites.

> **Incident rencontré pendant l'écriture de cette suite.** Un fichier de test
> contenant des chaînes ressemblant à des charges malveillantes (`MZ`, webshell
> PHP) a été mis en quarantaine par l'antivirus du poste, faisant échouer la
> suite pour une raison étrangère au code. Les charges sont désormais construites
> octet par octet. Consigné ici parce que le cas se reproduira sur un autre poste.

---

## 11. Responsabilités

| Rôle | Responsabilité |
|---|---|
| Auteur d'une modification | écrit les tests de son changement ; ne fusionne pas sans seuil atteint |
| Relecteur | vérifie que les tests peuvent échouer — un test qui passe toujours ne prouve rien |
| Pipeline | applique les seuils sans dérogation possible |
| Équipe | corrige un test instable dans la journée |

**Règle de relecture** : devant un nouveau test, se demander *« que faudrait-il
casser pour le faire échouer ? »*. Si la réponse est « rien », c'est un
`expect(true).toBe(true)` déguisé.

---

## 12. Ce que ce plan ne couvre pas

| Absence | Motif | Suite prévue |
|---|---|---|
| Tests de charge | aucun objectif de performance chiffré à ce jour | après formalisation des objectifs de service |
| Tests d'accessibilité | interface réduite à deux écrans | à la refonte du frontend |
| Analyse dynamique (OWASP ZAP) | exige un environnement déployé | à l'ouverture du staging |
| Tests de restauration automatisés | procédure manuelle mensuelle documentée | `docs/RUNBOOK.md` § 7 |
| Contrat entre le frontend et l'API | couvert indirectement par les tests de fumée | tests de contrat dédiés |

Ces absences sont des décisions, pas des oublis. Les inscrire ici est ce qui
distingue une limite assumée d'une lacune ignorée.

---

*Plan de tests — à réviser à chaque incident de production non détecté par la suite.*
