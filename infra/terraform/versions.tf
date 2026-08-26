# =============================================================================
# Versions
#
# Toutes epinglees. Le pipeline audite referencait `appleboy/ssh-action@master`,
# une branche mutable executee avec les identifiants de production : une
# modification en amont s'appliquait sans revue. Le meme raisonnement vaut pour
# l'infrastructure — une montee de version de fournisseur doit etre un commit,
# pas une surprise.
# =============================================================================

terraform {
  required_version = "~> 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Etat distant, verrouille : deux applications simultanees ne peuvent pas se
  # marcher dessus. Meme raisonnement que le controle de concurrence du
  # pipeline (constat CIC-09).
  backend "s3" {
    # Valeurs fournies par environnements/<env>.backend.hcl
    encrypt        = true
    dynamodb_table = "hrflow-terraform-verrous"
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Projet       = "hrflow"
      Environnement = var.environnement
      GerePar      = "terraform"
      Depot        = "github.com/lukunkuSarah/novatech-hrflow"
    }
  }
}
