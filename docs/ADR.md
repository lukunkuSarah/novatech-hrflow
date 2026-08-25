# Journal des décisions d'architecture

Chaque décision structurante est consignée ici avec son contexte et ses
conséquences, y compris négatives. Le dépôt audité n'en gardait aucune trace :
personne ne savait plus pourquoi le middleware d'authentification avait été
commenté « temporairement » en mars 2024, ni si la raison tenait toujours.

---

## ADR-001 — Supprimer les routes dangereuses plutôt que les sécuriser

**Date** : jour 1 · **Statut** : accepté

### Contexte

Deux routes exposaient le système sans authentification :
`POST /paie/migrate`, cause directe de l'incident P1 du 14 août 2024, et
`GET /conges/debug/all`, qui retournait les données RH de tous les clients.

La réaction naturelle est de les protéger : ajouter un contrôle de rôle, les
restreindre à une plage d'adresses. L'audit Partech recommande d'ailleurs de
« sécuriser ou supprimer » la route de migration.

### Décision

Les supprimer, sans remplacement protégé.

### Motifs

Une migration de schéma n'est pas une fonctionnalité de l'application. Elle ne
doit pas s'exécuter dans le processus qui sert le trafic, quel que soit le
niveau d'authentification exigé pour la déclencher. Elle est désormais un
fichier versionné appliqué par un conteneur éphémère.

Une route de debug protégée reste une route de debug : elle contourne le modèle
d'autorisation par construction, et sa protection est ce que l'on oublie de
vérifier. Le besoin de diagnostic est couvert par la journalisation structurée.

### Conséquences

- Le diagnostic exige désormais l'accès aux journaux ou à la base : c'est plus
  contraignant, et c'est voulu.
- Deux tests de non-régression vérifient que ces routes répondent 404.

---

## ADR-002 — Refuser de démarrer plutôt qu'appliquer une valeur par défaut

**Date** : jour 1 · **Statut** : accepté

### Contexte

Le code contenait des valeurs de repli codées en dur :

```js
process.env.JWT_SECRET || 'novatech_jwt_super_secret_key_…'
process.env.DB_PASSWORD || 'Nt@2021#Prod!…'
process.env.STRIPE_SECRET_KEY || 'sk_live_51NovaTech…'
```

Ces valeurs permettent à un service de démarrer dans un environnement mal
configuré. C'est précisément le problème : il démarre, il semble fonctionner, et
il signe des jetons avec un secret public.

### Décision

Aucune valeur de repli pour un secret. `loadConfig` lève une exception au
démarrage si une variable requise est absente ou vide.

### Conséquences

- Une erreur de configuration se voit immédiatement, au démarrage, avec la liste
  des variables manquantes — plutôt que six mois plus tard, dans un rapport d'audit.
- Le déploiement échoue si le gestionnaire de secrets n'a pas été renseigné.
  C'est le comportement souhaitable : mieux vaut un service qui ne démarre pas
  qu'un service qui démarre compromis.
- Un test vérifie ce refus, et le pipeline interdit le motif `process.env.X || '...'`.

---

## ADR-003 — Conserver le jeton d'accès en mémoire côté navigateur

**Date** : jour 2 · **Statut** : accepté, avec une évolution identifiée

### Contexte

Le jeton était écrit dans `localStorage`, accessible à tout script exécuté dans
la page — y compris une dépendance compromise. Trois options :

| Option | Résistance au XSS | Persistance | Coût |
|---|---|---|---|
| `localStorage` | nulle | oui | — |
| Mémoire seule | bonne | non | faible |
| Cookie `httpOnly` + `SameSite` | bonne | oui | modifications côté serveur |

### Décision

Mémoire seule pour l'instant. Cookie `httpOnly` posé par le service
d'authentification comme cible.

### Motifs

Le passage au cookie exige de gérer la protection CSRF, le partage de domaine
entre l'interface et l'API, et les en-têtes `credentials` du CORS. C'est du
travail justifié, mais qui ne doit pas retarder la fermeture d'une exposition
au vol de jeton.

### Conséquences

- Un rechargement de page redemande une connexion. Inconvénient réel et assumé.
- Un test vérifie qu'aucun jeton n'est écrit dans le stockage du navigateur.

---

## ADR-004 — Aucune action tierce dans le pipeline

**Date** : jour 3 · **Statut** : accepté

### Contexte

Le pipeline audité utilisait `appleboy/ssh-action@master` : une référence
mutable, dont le code s'exécutait automatiquement **avec les identifiants de
production**. Toute modification amont — volontaire ou par compromission du
dépôt — s'exécutait sans revue.

### Décision

Aucune action tierce. Seules les actions officielles GitHub (`actions/checkout`,
`actions/setup-node`, `actions/upload-artifact`), épinglées sur une version
majeure. Tout le reste passe par des commandes shell explicites ou des images
Docker versionnées (`gitleaks:v8.18.4`, `trivy:0.54.1`).

### Conséquences

- Le fichier de workflow est plus verbeux : le déploiement SSH est écrit à la
  main plutôt qu'appelé en trois lignes. En contrepartie, il est lisible et
  auditable.
- Prochaine étape identifiée : épingler par empreinte (`@sha256:…`) plutôt que
  par version, ce qui supprime le dernier risque résiduel.

---

## ADR-005 — Reprendre le barème de paie à l'identique

**Date** : jour 2 · **Statut** : accepté

### Contexte

Le calcul de paie utilise des taux codés en dur, annotés dans le code source
« taux approximatif — pas à jour 2024 » et « à vérifier avec le comptable ».
Il ne gère ni le temps partiel, ni les heures supplémentaires, ni la CSG/CRDS,
et n'arrondit pas.

### Décision

Corriger ce qui relève de la technique — arrondis au centime en arithmétique
entière, idempotence, transactions. Reprendre les taux **à l'identique**, en les
sortant du code sous forme de barème daté et explicitement marqué non validé.
Refuser d'émettre un bulletin pour les cas hors périmètre couvert.

### Motifs

Un défaut d'arrondi est un défaut technique : nous savons le corriger. Un taux
de cotisation est une donnée réglementaire : le corriger sans validation d'un
expert-comptable remplacerait une erreur par une autre, avec la même apparence
de justesse.

Refuser plutôt que calculer approximativement : un bulletin non émis est un
incident visible qui remonte ; un bulletin faux est un contentieux différé.

### Conséquences

- Les bulletins des salariés à temps partiel ne sont plus émis automatiquement.
  Régression fonctionnelle assumée et signalée à la direction.
- Le sort des bulletins déjà émis avec un calcul erroné est une décision
  juridique et comptable, hors du périmètre technique.

---

## ADR-006 — Une variante allégée de GitFlow, pas un modèle à branche unique

**Date** : jour 3 · **Statut** : accepté, à revoir dans six mois

### Contexte

Le dépôt comptait trois branches (`main`, `dev`, `feature/recrutement-v2`), sans
protection, avec des envois directs sur `main` et une branche `dev` qui
déclenchait le déploiement en production.

### Décision

`main` protégée, `develop` d'intégration, branches courtes `feature/*`, `fix/*`,
`hotfix/*`. Fusion par demande de fusion uniquement, étapes 1 à 3 obligatoires,
une revue requise.

### Motifs

Un modèle à branche unique serait préférable à terme : cycle plus court, moins
de divergence. Mais il suppose une couverture de tests mature et une culture de
la petite modification fréquente. Cette équipe vient d'hériter d'un système à
0 % de couverture dont l'expert est parti.

On adopte le modèle correspondant au niveau de maturité réel, pas au modèle
idéal. La question se repose quand la couverture est stable et le déploiement
routinier.

### Conséquences

- Une étape d'intégration supplémentaire, donc un cycle légèrement plus long.
- Revue prévue six mois après la mise en service du pipeline.

---

## ADR-007 — Des drapeaux en configuration, pas un service externe

**Date** : jour 4 · **Statut** : accepté

### Contexte

Le `.env` audité contenait `# UNLEASH_URL=` et `# UNLEASH_SECRET=`, commentés
depuis 2021, suivis de « Feature flags (pas encore implémenté) ». Toute nouvelle
fonctionnalité partait donc pour 8 200 utilisateurs d'un coup, et la seule
marche arrière était un redéploiement — celle-là même qui manquait le 14 août.

Le sujet impose Unleash ou LaunchDarkly dans la pile technique.

### Décision

Implémenter les drapeaux en configuration, avec une interface volontairement
compatible avec Unleash : `actif(cle, contexte)`, activation par entreprise et
déploiement progressif par pourcentage.

### Motifs

Un service externe de drapeaux ajoute une dépendance réseau **dans le chemin de
chaque requête**. Pour une équipe qui compte six drapeaux et qui vient de perdre
son unique expert, c'est un point de panne supplémentaire mal payé.

La répartition progressive s'appuie sur une empreinte de la clé et de
l'identifiant client, pas sur un tirage aléatoire : un client ne doit pas voir
la fonctionnalité apparaître puis disparaître d'une requête à l'autre.

### Conséquences

- Changer un drapeau demande un redémarrage du service, là où Unleash
  l'appliquerait à chaud. Limite réelle, acceptable à cette échelle.
- Pas de tableau de bord : l'état est lisible par `drapeaux.etat()`.
- Le passage à Unleash reste possible sans toucher aux appels : c'est ce que
  garantit la forme de l'interface.

---

## ADR-008 — Instrumenter avant de superviser

**Date** : jour 4 · **Statut** : accepté

### Contexte

Le tableau de bord attendu doit présenter les quatre signaux d'or : latence,
trafic, erreurs, saturation. Or aucun service n'exposait la moindre métrique.
Un tableau de bord branché sur les seules sondes de disponibilité aurait affiché
deux états — debout ou tombé — et rien entre les deux.

### Décision

Instrumenter les services avec `prom-client` avant de construire le tableau de
bord. Compteur de requêtes et histogramme de durée, étiquetés par service,
route et statut ; métriques de processus pour la saturation.

### Motifs

**Un histogramme, pas une moyenne.** Une moyenne de latence masque exactement ce
qu'on cherche : une réponse sur cent à trois secondes ne la déplace pas, mais
c'est celle que l'utilisateur remarque. L'histogramme permet les centiles 95
et 99.

**Les routes sont normalisées en gabarits.** Sans cela, `/conges/solde/10` et
`/conges/solde/11` créent deux séries : avec 8 200 salariés, la base de
métriques explose. C'est le défaut classique d'une instrumentation posée vite.

### Conséquences

- Une dépendance de plus (`prom-client`), assumée : sans elle, le tableau de
  bord serait décoratif.
- `/metrics` révèle la topologie interne et les volumes : il est restreint au
  réseau de supervision par Nginx, comme la sonde de disponibilité.

---

*Journal des décisions — une entrée par choix structurant, y compris ceux qu'on regrettera.*
