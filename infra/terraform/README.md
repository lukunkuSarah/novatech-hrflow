# Infrastructure — Terraform

> **État : écrit, relu, non appliqué.**
>
> Ce code décrit l'infrastructure cible sur AWS ECS Fargate. Il n'a **pas** été
> exécuté : l'équipe ne dispose pas des identifiants du bac à sable mentionné
> dans le cahier des charges. Le dire ici est préférable à laisser croire à un
> déploiement qui n'a pas eu lieu.
>
> Ce qui est vérifiable en l'état : `terraform fmt -check`, `terraform validate`
> et une revue de code. Ce qui ne l'est pas : le comportement réel des services
> AWS, les temps de bascule et le coût effectif.

---

## Pourquoi Terraform malgré tout

Le système audité était déployé **à la main, depuis le poste d'une seule
personne**, par `sshpass` et une adresse IP codée en dur. Aucune trace de ce qui
avait été créé, aucun moyen de reconstruire l'environnement, et la connaissance
concentrée sur Théo Marchand — parti le 26 août 2024.

Décrire l'infrastructure en code répond à trois questions que le système audité
laissait sans réponse :

1. **Qu'y a-t-il en production ?** Le code est la réponse, pas la mémoire de
   quelqu'un.
2. **Comment reconstruire après un incident majeur ?** `terraform apply`, au
   lieu d'une journée de reconstitution.
3. **Qui a changé quoi, et quand ?** L'historique Git, comme pour le code
   applicatif.

---

## Architecture décrite

```
                    Internet
                        │
              ┌─────────▼─────────┐
              │  ALB  (HTTPS)     │  certificat ACM, redirection 80 → 443
              │  2 zones de dispo │
              └─────────┬─────────┘
                        │
        ┌───────────────┴───────────────┐
        │  Groupes cibles bleu / vert   │  bascule progressive CodeDeploy
        └───────────────┬───────────────┘
                        │
   ┌────────────────────▼────────────────────┐
   │  ECS Fargate — sous-réseaux privés      │
   │  api-gateway · auth · paie · conges ·   │
   │  recrutement · frontend                 │
   └────────────────────┬────────────────────┘
                        │
        ┌───────────────┴───────────────┐
        │  RDS PostgreSQL 16            │  multi-AZ, sauvegardes horaires
        │  Secrets Manager              │  rotation automatique
        │  S3 — CV des candidats        │  chiffré, versionné
        └───────────────────────────────┘
```

**Deux environnements réellement séparés** : `staging` et `production` sont deux
VPC distincts, deux bases distinctes, deux jeux de secrets. Le staging audité
partageait la machine et la configuration de la production — c'est la cause de
l'incident de juin 2024.

---

## Organisation des fichiers

| Fichier | Contenu |
|---|---|
| `versions.tf` | versions épinglées de Terraform et des fournisseurs |
| `variables.tf` | paramètres d'entrée, avec validations |
| `reseau.tf` | VPC, sous-réseaux, passerelles, groupes de sécurité |
| `donnees.tf` | RDS PostgreSQL, Secrets Manager, S3 |
| `calcul.tf` | cluster ECS, définitions de tâches, services |
| `repartiteur.tf` | ALB, groupes cibles bleu/vert, écouteurs |
| `deploiement.tf` | CodeDeploy — bascule progressive et retour arrière |
| `supervision.tf` | CloudWatch, alarmes, journalisation |
| `sorties.tf` | valeurs consommées par le pipeline |
| `environnements/` | valeurs par environnement |

---

## Ce que ce code garantit, et ce qu'il ne garantit pas

**Garanti par construction**

- Les bases ne sont accessibles que depuis les sous-réseaux privés.
- Aucun secret en clair : tout passe par Secrets Manager, injecté par ECS.
- Chiffrement au repos sur RDS et S3, en transit par TLS.
- Sauvegardes automatiques avec rétention de 30 jours et restauration à un
  instant donné.
- Suppression protégée sur la base de production.

**Non garanti tant que le code n'est pas appliqué**

- Les temps de bascule réels et la durée du retour arrière.
- Le coût effectif — l'estimation ci-dessous reste théorique.
- Le comportement des sondes de disponibilité sous charge.

---

## Estimation de coût

| Ressource | Configuration | Coût mensuel estimé |
|---|---|---|
| ECS Fargate | 6 services × 0,25 vCPU / 0,5 Go | ≈ 55 € |
| RDS PostgreSQL | `db.t4g.small`, multi-AZ | ≈ 95 € |
| ALB | 1 répartiteur, trafic modéré | ≈ 20 € |
| NAT Gateway | 2 zones de disponibilité | ≈ 65 € |
| S3, Secrets Manager, CloudWatch | volumétrie actuelle | ≈ 15 € |
| **Total** | | **≈ 250 €/mois** |

Le bac à sable évoqué dans le cahier des charges est limité à 50 €. Cette
architecture ne tient donc pas dans ce budget : il faudrait passer en mono-zone,
retirer le multi-AZ de la base et remplacer les passerelles NAT par des points
de terminaison VPC. Ce serait un environnement de démonstration, pas la cible.

---

## Mise en œuvre

```bash
cd infra/terraform

terraform init -backend-config=environnements/staging.backend.hcl
terraform plan  -var-file=environnements/staging.tfvars
terraform apply -var-file=environnements/staging.tfvars
```

L'état est conservé dans S3 avec verrouillage DynamoDB : deux applications
simultanées ne peuvent pas se marcher dessus — même raisonnement que le contrôle
de concurrence du pipeline.

---

## Ce qui reste à décider avant application

| Sujet | Décideur |
|---|---|
| Compte AWS et budget | direction technique |
| Nom de domaine et certificat ACM | direction technique |
| Rétention des sauvegardes au-delà de 30 jours | juridique — obligations RGPD |
| Dimensionnement au-delà de 12 000 utilisateurs | après mesure de la charge réelle |
