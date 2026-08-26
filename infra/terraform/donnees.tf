# =============================================================================
# Donnees — base, secrets, stockage des CV
#
# Trois constats de l'audit trouvent ici leur reponse structurelle :
#   SEC-01  les secrets etaient commites dans Git depuis 2021
#   SEC-07  les CV etaient ecrits dans /tmp, perdus a chaque redemarrage
#   INF-02  aucune sauvegarde automatique, aucune restauration jamais testee
# =============================================================================

resource "random_password" "base" {
  length  = 32
  special = true
  # Caracteres ecartes : ils cassent les chaines de connexion et les scripts.
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "aws_db_subnet_group" "principal" {
  name       = "hrflow-${var.environnement}"
  subnet_ids = aws_subnet.donnees[*].id
  tags       = { Name = "hrflow-${var.environnement}" }
}

resource "aws_db_instance" "principal" {
  identifier     = "hrflow-${var.environnement}"
  engine         = "postgres"
  engine_version = "16.4"
  instance_class = var.classe_base

  allocated_storage     = 20
  max_allocated_storage = 100
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "hrflow"
  username = "hrflow_admin"
  password = random_password.base.result

  db_subnet_group_name   = aws_db_subnet_group.principal.name
  vpc_security_group_ids = [aws_security_group.base.id]
  publicly_accessible    = false

  # Deux zones en production : une panne de centre de donnees ne doit pas
  # arreter la plateforme. Le contrat de service est de 99,5 % mensuel aupres
  # de 47 clients.
  multi_az = var.environnement == "production"

  # --- Sauvegardes (INF-02) --------------------------------------------------
  # Lors de l'incident du 14 aout, la sauvegarde la plus recente datait de
  # 1 h 17 avant la panne. La restauration a un instant donne ramene la perte
  # maximale a cinq minutes.
  backup_retention_period   = var.retention_sauvegardes
  backup_window             = "02:00-03:00"
  copy_tags_to_snapshot     = true
  delete_automated_backups  = false
  skip_final_snapshot       = var.environnement != "production"
  final_snapshot_identifier = var.environnement == "production" ? "hrflow-production-final-${var.version_image}" : null

  # Suppression protegee en production : un `terraform destroy` distrait ne
  # doit pas emporter les donnees de paie de 8 200 salaries.
  deletion_protection = var.environnement == "production"

  maintenance_window          = "sun:03:00-sun:04:00"
  auto_minor_version_upgrade  = true
  performance_insights_enabled = true
  enabled_cloudwatch_logs_exports = ["postgresql"]

  tags = { Name = "hrflow-${var.environnement}" }
}

# =============================================================================
# Secrets — SEC-01
#
# Aucune valeur dans le code, aucune dans une variable d'environnement du depot.
# ECS les injecte dans la tache au demarrage ; l'application ne les voit que
# comme des variables de processus, et refuse de demarrer si l'une manque
# (ADR-002).
# =============================================================================

resource "random_password" "jwt" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "application" {
  name        = "hrflow/${var.environnement}/application"
  description = "Secrets applicatifs HRFlow — rotation trimestrielle"

  # Fenetre de recuperation : une suppression accidentelle reste rattrapable
  # pendant trente jours.
  recovery_window_in_days = var.environnement == "production" ? 30 : 7
}

resource "aws_secretsmanager_secret_version" "application" {
  secret_id = aws_secretsmanager_secret.application.id

  secret_string = jsonencode({
    DATABASE_URL = "postgres://${aws_db_instance.principal.username}:${random_password.base.result}@${aws_db_instance.principal.endpoint}/hrflow?sslmode=require"
    JWT_SECRET   = random_password.jwt.result
    # Renseignes hors Terraform : ils proviennent de prestataires externes et
    # n'ont pas a transiter par l'etat Terraform.
    STRIPE_SECRET_KEY = "a-renseigner-hors-terraform"
    SENDGRID_API_KEY  = "a-renseigner-hors-terraform"
  })

  lifecycle {
    # Les valeurs renseignees a la main ne doivent pas etre ecrasees au
    # prochain `apply`.
    ignore_changes = [secret_string]
  }
}

# =============================================================================
# Stockage des CV — SEC-07
#
# Les CV etaient ecrits dans /tmp du conteneur : perdus a chaque redemarrage,
# ce qui constitue aussi un defaut d'integrite au sens du RGPD.
# =============================================================================

resource "aws_s3_bucket" "cv" {
  bucket = "hrflow-${var.environnement}-cv"
  tags   = { Name = "hrflow-${var.environnement}-cv" }
}

resource "aws_s3_bucket_public_access_block" "cv" {
  bucket = aws_s3_bucket.cv.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cv" {
  bucket = aws_s3_bucket.cv.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "cv" {
  bucket = aws_s3_bucket.cv.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_lifecycle_configuration" "cv" {
  bucket = aws_s3_bucket.cv.id

  # Purge automatique — RGPD, article 5 : les candidatures ne se conservent pas
  # indefiniment. La meme echeance figure en base, colonne purge_prevue_le.
  rule {
    id     = "purge-rgpd"
    status = "Enabled"
    filter {}

    expiration { days = 730 }

    noncurrent_version_expiration { noncurrent_days = 30 }
  }
}
