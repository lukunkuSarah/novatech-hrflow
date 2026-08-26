# Recette — machine et base distinctes de la production.
#
# Le staging audite partageait la machine, la configuration Nginx et
# vraisemblablement la base de la production : c'est la cause de l'incident de
# juin 2024 (constats SEC-16, INF-07).

environnement = "staging"
region        = "eu-west-3"
domaine       = "staging.hrflow.novatech.io"

# A renseigner apres creation du certificat ACM.
certificat_arn = "arn:aws:acm:eu-west-3:000000000000:certificate/A-RENSEIGNER"

cidr_vpc            = "10.10.0.0/16"
zones_disponibilite = ["eu-west-3a", "eu-west-3b"]

# Instance plus modeste et zone unique : la recette n'a pas d'engagement de
# disponibilite.
classe_base           = "db.t4g.micro"
retention_sauvegardes = 7

# Renseignee par le pipeline : -var="version_image=$GITHUB_SHA"
version_image = "0000000"
