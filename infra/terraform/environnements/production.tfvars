# Production — 8 200 utilisateurs, 47 clients, engagement de 99,5 % mensuel.

environnement = "production"
region        = "eu-west-3"
domaine       = "hrflow.novatech.io"

certificat_arn = "arn:aws:acm:eu-west-3:000000000000:certificate/A-RENSEIGNER"

cidr_vpc            = "10.20.0.0/16"
zones_disponibilite = ["eu-west-3a", "eu-west-3b"]

classe_base           = "db.t4g.small"
retention_sauvegardes = 30

version_image = "0000000"
