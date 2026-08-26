# =============================================================================
# Parametres d'entree
#
# Chaque variable qui peut faire tomber la production porte une validation.
# C'est le meme principe que `loadConfig` cote applicatif (ADR-002) : mieux vaut
# echouer au plan qu'appliquer une valeur silencieusement fausse.
# =============================================================================

variable "environnement" {
  description = "Environnement cible"
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environnement)
    error_message = "L'environnement doit valoir 'staging' ou 'production'. Le script de deploiement audite acceptait n'importe quelle valeur et deployait la production quoi qu'il arrive (constat INF-05)."
  }
}

variable "region" {
  description = "Region AWS"
  type        = string
  default     = "eu-west-3" # Paris — les donnees RH restent en France
}

variable "domaine" {
  description = "Nom de domaine servi par le repartiteur"
  type        = string
}

variable "certificat_arn" {
  description = "Certificat ACM. Sans lui, pas de TLS — et le systeme audite acceptait le trafic en clair (SEC-14)."
  type        = string
}

# -----------------------------------------------------------------------------
# Reseau
# -----------------------------------------------------------------------------
variable "cidr_vpc" {
  description = "Plage d'adresses du VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "zones_disponibilite" {
  description = "Zones de disponibilite. Deux au minimum : une seule zone signifie qu'une panne de centre de donnees coupe la plateforme."
  type        = list(string)
  default     = ["eu-west-3a", "eu-west-3b"]

  validation {
    condition     = length(var.zones_disponibilite) >= 2
    error_message = "Au moins deux zones de disponibilite sont requises."
  }
}

variable "reseau_supervision" {
  description = "Plage autorisee a joindre /metrics et /health/ready. Ces points d'entree revelent la topologie interne et les volumes de trafic."
  type        = string
  default     = "10.0.0.0/8"
}

# -----------------------------------------------------------------------------
# Base de donnees
# -----------------------------------------------------------------------------
variable "classe_base" {
  description = "Classe d'instance RDS"
  type        = string
  default     = "db.t4g.small"
}

variable "retention_sauvegardes" {
  description = "Jours de conservation des sauvegardes automatiques"
  type        = number
  default     = 30

  validation {
    condition     = var.retention_sauvegardes >= 7
    error_message = "Sept jours au minimum. Lors de l'incident du 14 aout 2024, la sauvegarde la plus recente datait de 1 h 17 avant la panne, et aucune restauration n'avait jamais ete testee."
  }
}

# -----------------------------------------------------------------------------
# Services
# -----------------------------------------------------------------------------
variable "version_image" {
  description = "Empreinte de commit des images a deployer. Jamais 'latest' : ce qui est deploye doit etre identifiable."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{7,40}$", var.version_image))
    error_message = "La version doit etre une empreinte de commit. 'latest' interdit : il rend impossible de savoir ce qui tourne (constat CIC-10)."
  }
}

variable "registre" {
  description = "Registre d'images"
  type        = string
  default     = "ghcr.io/lukunkusarah/novatech-hrflow"
}

variable "services" {
  description = "Services deployes sur ECS, avec leur port et leur dimensionnement."
  type = map(object({
    port     = number
    cpu      = number
    memoire  = number
    replicas = number
    public   = bool
  }))

  default = {
    "api-gateway" = { port = 3000, cpu = 256, memoire = 512, replicas = 2, public = true }
    "auth"        = { port = 3001, cpu = 256, memoire = 512, replicas = 2, public = false }
    "paie"        = { port = 3002, cpu = 256, memoire = 512, replicas = 2, public = false }
    "conges"      = { port = 3003, cpu = 256, memoire = 512, replicas = 2, public = false }
    "recrutement" = { port = 3004, cpu = 256, memoire = 512, replicas = 2, public = false }
  }

  validation {
    # Deux instances au minimum, sinon la bascule sans interruption est
    # impossible : c'est ce qu'a montre la mesure locale, ou le remplacement de
    # la passerelle en instance unique coupe forcement le service.
    condition     = alltrue([for s in var.services : s.replicas >= 2])
    error_message = "Chaque service doit avoir au moins deux instances : une seule rend le deploiement sans interruption impossible."
  }
}

variable "alerte_slack_webhook" {
  description = "URL du webhook Slack pour les alertes. Vide : le routage est desactive explicitement."
  type        = string
  default     = ""
  sensitive   = true
}
