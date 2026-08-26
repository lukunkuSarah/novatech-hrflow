# =============================================================================
# Repartiteur de charge et bascule bleu/vert
#
# C'est ici que se joue le deploiement sans interruption — et c'est exactement
# ce que la mesure locale a montre manquant.
#
# scripts/demo-zero-downtime.sh mesure zero requete perdue tant qu'on remplace
# un service METIER : la passerelle reste debout et continue de servir. Mais le
# remplacement de la passerelle elle-meme coupe forcement, puisqu'il n'y a
# qu'une instance et rien devant elle.
#
# Deux groupes cibles et une bascule pilotee suppriment ce dernier trou : le
# trafic passe du groupe bleu au groupe vert une fois celui-ci declare
# disponible, jamais avant.
# =============================================================================

resource "aws_lb" "principal" {
  name               = "hrflow-${var.environnement}"
  load_balancer_type = "application"
  internal           = false
  subnets            = aws_subnet.public[*].id
  security_groups    = [aws_security_group.repartiteur.id]

  # Une suppression accidentelle du repartiteur coupe la plateforme entiere.
  enable_deletion_protection = var.environnement == "production"

  # Superieur au delai d'expiration applicatif (30 s cote Nginx) pour que ce
  # soit l'application qui decide, pas le repartiteur.
  idle_timeout = 60

  drop_invalid_header_fields = true

  access_logs {
    bucket  = aws_s3_bucket.journaux.id
    prefix  = "alb"
    enabled = true
  }

  tags = { Name = "hrflow-${var.environnement}" }
}

resource "aws_s3_bucket" "journaux" {
  bucket = "hrflow-${var.environnement}-journaux"
  tags   = { Name = "hrflow-${var.environnement}-journaux" }
}

resource "aws_s3_bucket_public_access_block" "journaux" {
  bucket = aws_s3_bucket.journaux.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Les journaux etaient servis publiquement par Nginx, avec listing active, et
# contenaient adresses e-mail, roles et mots de passe reinitialises (SEC-15).
# Ici : bloc d'acces public, chiffrement, purge automatique.
resource "aws_s3_bucket_lifecycle_configuration" "journaux" {
  bucket = aws_s3_bucket.journaux.id

  rule {
    id     = "purge"
    status = "Enabled"
    filter {}
    expiration { days = 90 }
  }
}

# -----------------------------------------------------------------------------
# Groupes cibles — bleu et vert
# -----------------------------------------------------------------------------
resource "aws_lb_target_group" "bleu" {
  name        = "hrflow-${var.environnement}-bleu"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.principal.id
  target_type = "ip"

  health_check {
    enabled = true
    # /health/ready et non /health/live : le repartiteur ne doit envoyer du
    # trafic qu'a une instance capable de le traiter, dependances comprises.
    path                = "/health/ready"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }

  # Retire l'instance du service et laisse les requetes en cours se terminer,
  # au lieu de les couper. C'est le pendant de l'arret progressif implemente
  # cote applicatif dans shared/bootstrap.js (INF-06).
  deregistration_delay = 30

  tags = { Name = "hrflow-${var.environnement}-bleu" }
}

resource "aws_lb_target_group" "vert" {
  name        = "hrflow-${var.environnement}-vert"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.principal.id
  target_type = "ip"

  health_check {
    enabled             = true
    path                = "/health/ready"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }

  deregistration_delay = 30

  tags = { Name = "hrflow-${var.environnement}-vert" }
}

# -----------------------------------------------------------------------------
# Ecouteurs
# -----------------------------------------------------------------------------

# Le systeme audite acceptait le trafic en clair : identifiants et jetons
# transitaient sans chiffrement (SEC-14). Ici, HTTP ne sert qu'a rediriger.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.principal.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.principal.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificat_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.bleu.arn
  }

  lifecycle {
    # CodeDeploy bascule l'ecouteur d'un groupe a l'autre pendant le
    # deploiement : Terraform ne doit pas revenir dessus.
    ignore_changes = [default_action]
  }
}

# Ecouteur de test : permet de valider la version verte avant de lui envoyer du
# trafic reel. Restreint au reseau interne.
resource "aws_lb_listener" "test" {
  load_balancer_arn = aws_lb.principal.arn
  port              = 8443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificat_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.vert.arn
  }

  lifecycle {
    ignore_changes = [default_action]
  }
}
