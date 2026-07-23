# Rapport d'Audit Technique — NovaTech HRFlow
**Cabinet** : TechAudit Conseil  
**Commanditaire** : Partech Ventures  
**Date** : 18 septembre 2024  
**Confidentiel — Ne pas diffuser**

---

## Synthèse Exécutive

L'audit technique de la plateforme HRFlow révèle une dette technique critique accumulée depuis 2021.
L'infrastructure actuelle ne peut pas supporter une croissance au-delà de 12 000 utilisateurs
sans risque d'effondrement. Les incidents récents (P1 du 14 août, fuite de données de juin)
ne sont pas des accidents isolés mais la conséquence prévisible d'un manque structurel
de pratiques DevOps et de qualité logicielle.

**Notre recommandation : gel du second versement jusqu'à présentation d'un plan de remédiation
crédible et exécutable dans 60 jours.**

---

## 1. Sécurité — Niveau de risque : CRITIQUE

### 1.1 Secrets exposés dans le repository Git
- Le fichier `.env` contenant les secrets de production (JWT, AWS, Stripe, SMTP) est **commité dans Git**
- Ces secrets sont présents dans tout l'historique Git depuis octobre 2021
- **Recommandation immédiate** : rotation de TOUS les secrets, migration vers AWS Secrets Manager ou GitHub Secrets

### 1.2 Vulnérabilité d'injection SQL
- Le service `auth` construit une requête SQL par concaténation de chaîne :
  `SELECT * FROM users WHERE email = '${email}'`
- Exploitable sans authentification préalable
- **Criticité : HAUTE**

### 1.3 Endpoint de migration non sécurisé
- La route `POST /paie/migrate` exécute des migrations SQL en production sans authentification
- C'est la cause directe de l'incident P1 du 14 août 2024
- **À désactiver immédiatement**

### 1.4 Endpoint de debug exposé
- `GET /conges/debug/all` retourne l'ensemble des données RH sans authentification
- Expose les données personnelles de tous les employés de tous les clients
- **Violation RGPD caractérisée**

### 1.5 CORS permissif
- L'API Gateway accepte toutes les origines (`Access-Control-Allow-Origin: *`)
- Middleware d'authentification désactivé depuis mars 2024

---

## 2. Qualité Logicielle — Niveau de risque : ÉLEVÉ

### 2.1 Couverture de tests
- **0%** de tests sur les 4 services backend
- 2 fichiers de tests unitaires présents dans le frontend, tous désactivés
- Aucun test d'intégration, aucun test E2E

### 2.2 Pipeline CI/CD
- Le pipeline GitHub Actions actuel ne fait que `npm install && npm build`
- Aucune gate de qualité (lint, tests, sécurité)
- Node.js 16 (EOL depuis septembre 2023) utilisé en CI
- Déclenchement sur `main` ET `dev` — déploie du code non validé

### 2.3 Gestion des erreurs
- Les erreurs Stripe sont silencieusement ignorées dans le service paie
- Les stack traces complètes sont exposées aux clients en production
- Le JWT_SECRET est logué en clair au démarrage du serveur

---

## 3. Infrastructure — Niveau de risque : ÉLEVÉ

### 3.1 Déploiement
- Déploiement entièrement manuel via SSH depuis le poste de Théo Marchand
- Authentification SSH par mot de passe (non par clé)
- Mot de passe SSH stocké en clair dans `scripts/deploy.sh`
- Aucun processus de validation avant mise en production

### 3.2 Monitoring & Alerting
- Aucun système de monitoring en place
- L'incident P1 a duré 3h07 car aucune alerte automatique n'existait
- Découvert par un client à 2h15 du matin

### 3.3 Backup
- Pas de politique de backup documentée
- Dernier backup disponible lors de l'incident P1 : 22h30 (1h17 avant l'incident)
- Pas de test de restauration depuis la création du système

### 3.4 Configuration Nginx
- Staging accessible sans authentification (cause de l'incident de juin 2024)
- Répertoire `/logs/` accessible publiquement avec listing activé
- Aucun header de sécurité HTTP (CSP, HSTS, X-Frame-Options)
- HTTP accepté sans redirection HTTPS

---

## 4. Documentation — Niveau de risque : MOYEN

- Aucun schéma d'architecture à jour
- README daté de mars 2022 ("voir Théo" pour le déploiement)
- Aucune documentation des API (pas de Swagger/OpenAPI)
- Aucun runbook d'incident
- Connaissance du système concentrée sur une seule personne (Théo Marchand)

---

## 5. Évaluation Globale

| Domaine | Niveau de risque | Score /10 |
|---------|-----------------|-----------|
| Sécurité | 🔴 CRITIQUE | 1/10 |
| Tests & Qualité | 🔴 ÉLEVÉ | 1/10 |
| CI/CD | 🔴 ÉLEVÉ | 2/10 |
| Infrastructure | 🟠 ÉLEVÉ | 3/10 |
| Documentation | 🟡 MOYEN | 2/10 |
| **GLOBAL** | **🔴 CRITIQUE** | **1.8/10** |

---

## 6. Plan de remédiation attendu

Dans les 60 jours, NovaTech devra démontrer :

1. **Rotation complète des secrets** et mise en place d'une gestion sécurisée (AWS Secrets Manager ou équivalent)
2. **Pipeline CI/CD complet** : build, tests automatisés (≥ 80% coverage), scan de sécurité, déploiement automatisé staging puis prod
3. **Couverture de tests** ≥ 80% sur les routes critiques des 4 services
4. **Monitoring opérationnel** avec alerting automatique (délai de détection < 2 minutes pour un incident P1)
5. **Déploiement zero-downtime** avec procédure de rollback documentée et testée (< 10 min)
6. **Fermeture des vulnérabilités critiques** (injection SQL, endpoints non protégés, CORS)
7. **Documentation technique** : OpenAPI, README opérationnel, runbook d'incident

*Le second versement de 1 800 000 € sera conditionné à la validation de ces points par un contre-audit.*

---

*TechAudit Conseil — Document confidentiel — NovaTech SAS / Partech Ventures — Septembre 2024*
