# 📋 ShipIt — Prise en main du repo NovaTech HRFlow

Bienvenue sur le repository de NovaTech HRFlow.  
Ce repo est celui que vous avez reçu de **Théo Marchand** (Lead Dev) la veille de votre arrivée.

---

## 🎯 Votre mission — Jour 1 matin

Avant de toucher une seule ligne de code, vous devez **auditer ce repo de fond en comble**.  
Un audit rigoureux en J1 est la base de tout ce qui suivra. Bâcler cette étape, c'est partir sur du sable.

---

## 📂 Ce que vous avez

```
novatech-hrflow/
├── .env                          ← à examiner en priorité
├── .github/workflows/deploy.yml  ← le pipeline actuel
├── .gitignore                    ← est-il bien configuré ?
├── README.md                     ← quelle est sa qualité ?
├── docs/
│   ├── architecture.md           ← état de la documentation
│   ├── audit-partech-sept-2024.md  ← rapport d'audit complet
│   └── incident-aout-2024.md     ← post-mortem P1
├── frontend/                     ← app React
├── nginx/hrflow.conf             ← configuration serveur
├── scripts/deploy.sh             ← processus de déploiement actuel
└── services/
    ├── api-gateway/              ← point d'entrée de l'API
    ├── auth/                     ← authentification & JWT
    ├── conges/                   ← gestion des congés
    ├── paie/                     ← calcul et émission des bulletins
    └── recrutement/              ← gestion des candidatures
```

---

## 🔍 Grille d'audit J1 — à compléter en équipe

Pour chaque service et chaque fichier de configuration, documentez :

### A. Sécurité
- [ ] Y a-t-il des secrets, tokens ou mots de passe exposés ? Où ?
- [ ] Les endpoints sont-ils protégés par authentification ?
- [ ] Y a-t-il des vulnérabilités évidentes dans le code (injection, CORS, upload...) ?
- [ ] La configuration Nginx expose-t-elle des données sensibles ?

### B. Qualité du code
- [ ] Y a-t-il des tests ? Fonctionnent-ils ?
- [ ] Y a-t-il de la gestion d'erreurs ? Est-elle correcte ?
- [ ] Quels sont les TODO/FIXME présents ? Lesquels sont critiques ?
- [ ] Y a-t-il du code mort ou des fichiers qui ne devraient pas être là ?

### C. Pipeline CI/CD
- [ ] Que fait réellement le pipeline actuel ?
- [ ] Qu'est-ce qui manque ? Dans quel ordre le rajouter ?
- [ ] Sur quelles branches se déclenche-t-il ? Est-ce correct ?
- [ ] Quelle version de Node.js est utilisée ? Est-ce à jour ?

### D. Infrastructure & déploiement
- [ ] Comment se fait le déploiement aujourd'hui ? Quels sont les risques ?
- [ ] Y a-t-il un monitoring ? Un alerting ? Des backups ?
- [ ] L'environnement staging est-il correctement isolé ?

### E. Documentation
- [ ] Le README permet-il à quelqu'un de nouveau de démarrer le projet ?
- [ ] L'architecture est-elle documentée quelque part ?
- [ ] Existe-t-il une procédure d'incident ou de rollback ?

---

## 📊 Livrable attendu en fin de J1

Un **rapport d'audit structuré** (peut être un Notion, Google Doc ou Markdown) avec :

1. **Liste priorisée des problèmes** identifiés (classés par criticité : Critique / Élevé / Moyen / Faible)
2. **Schéma d'architecture** de l'existant (draw.io, Excalidraw ou équivalent) — 4 services + gateway + BDD
3. **Plan de remédiation** : dans quel ordre allez-vous corriger les problèmes ? Pourquoi cet ordre ?
4. **Architecture cible du pipeline** : schéma des 5 stages que vous allez construire

> 💡 **Conseil** : lisez d'abord le rapport d'audit Partech (`docs/audit-partech-sept-2024.md`) et le post-mortem de l'incident P1 (`docs/incident-aout-2024.md`). Ils vous donnent une lecture critique de l'état du système — mais faites votre propre analyse : vous pourrez trouver des problèmes que Partech n'a pas listés.

---

## ⚠️ Règles importantes

- **Ne pas pusher sur `main` sans pipeline qui passe** — vous connaissez les conséquences
- **Ne pas déployer en production avant J3** — environment staging d'abord
- **Documenter chaque décision** : pourquoi ce choix d'outil ? pourquoi cette stratégie de branchement ?
- **Tous les membres doivent comprendre tout le code** — le jury interrogera chacun individuellement

---

*NovaTech HRFlow — Document fourni le Jour 1 par Théo Marchand — Confidentiel*
