# =============================================================================
# Calcul — cluster ECS Fargate
#
# Le systeme audite tournait sur un VPS unique, avec pm2 et un deploiement
# manuel par SSH depuis le poste d'une seule personne (INF-04, INF-08).
#
# Fargate supprime la machine a administrer : plus de correctifs systeme, plus
# de « il faut demander a Theo ». La contrepartie est un cout superieur a un
# serveur nu — assumee pour une equipe qui vient de perdre son unique expert.
# =============================================================================

resource "aws_ecs_cluster" "principal" {
  name = "hrflow-${var.environnement}"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "services" {
  for_each = var.services

  name              = "/ecs/hrflow-${var.environnement}/${each.key}"
  retention_in_days = 30

  tags = { Service = each.key }
}

# -----------------------------------------------------------------------------
# Roles
#
# Deux roles distincts, et la distinction compte :
#   execution — permet a ECS de demarrer la tache : tirer l'image, lire les secrets
#   tache     — permissions du code applicatif lui-meme
#
# Les confondre donnerait au code applicatif le droit de lire tous les secrets
# du compte.
# -----------------------------------------------------------------------------
data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "hrflow-${var.environnement}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_base" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "lecture_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.application.arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "lecture-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.lecture_secrets.json
}

resource "aws_iam_role" "tache" {
  name               = "hrflow-${var.environnement}-tache"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

# Seul le service recrutement ecrit des CV : lui seul recoit ce droit.
data "aws_iam_policy_document" "acces_cv" {
  statement {
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.cv.arn}/*"]
  }
}

resource "aws_iam_role_policy" "tache_cv" {
  name   = "acces-cv"
  role   = aws_iam_role.tache.id
  policy = data.aws_iam_policy_document.acces_cv.json
}

# -----------------------------------------------------------------------------
# Definitions de taches
# -----------------------------------------------------------------------------
resource "aws_ecs_task_definition" "service" {
  for_each = var.services

  family                   = "hrflow-${var.environnement}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memoire
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.tache.arn

  container_definitions = jsonencode([
    {
      name = each.key
      # Empreinte de commit, jamais 'latest' : ce qui tourne doit etre
      # identifiable (constat CIC-10).
      image     = "${var.registre}/${each.key}:${var.version_image}"
      essential = true

      portMappings = [{ containerPort = each.value.port, protocol = "tcp" }]

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "PORT", value = tostring(each.value.port) },
        { name = "APP_VERSION", value = var.version_image },
        { name = "ALLOWED_ORIGINS", value = "https://${var.domaine}" },
        { name = "AUTH_URL", value = "http://auth.hrflow.local:3001" },
        { name = "PAIE_URL", value = "http://paie.hrflow.local:3002" },
        { name = "CONGES_URL", value = "http://conges.hrflow.local:3003" },
        { name = "RECRUTEMENT_URL", value = "http://recrutement.hrflow.local:3004" },
        { name = "UPLOAD_BUCKET", value = aws_s3_bucket.cv.bucket },
      ]

      # Injectes par ECS depuis Secrets Manager : jamais dans le code, jamais
      # dans une variable du depot (SEC-01, SEC-09).
      secrets = [
        { name = "DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.application.arn}:DATABASE_URL::" },
        { name = "JWT_SECRET", valueFrom = "${aws_secretsmanager_secret.application.arn}:JWT_SECRET::" },
        { name = "STRIPE_SECRET_KEY", valueFrom = "${aws_secretsmanager_secret.application.arn}:STRIPE_SECRET_KEY::" },
      ]

      # Sonde de DISPONIBILITE et non de vivacite : elle interroge reellement
      # les dependances. L'ancienne repondait 200 en toutes circonstances, et
      # une supervision branchee dessus serait restee verte pendant les 3 h 07
      # de l'incident (INF-01).
      healthCheck = {
        command     = ["CMD-SHELL", "curl -fsS http://127.0.0.1:${each.value.port}/health/ready || exit 1"]
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }

      # Systeme de fichiers en lecture seule : un service compromis ne peut pas
      # deposer de fichier. Complementaire de SEC-07.
      readonlyRootFilesystem = true
      user                   = "node"

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.services[each.key].name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])
}

# -----------------------------------------------------------------------------
# Decouverte de services
#
# Les adresses etaient codees en dur dans la passerelle auditee. Un nom DNS
# interne les remplace : une instance qui disparait est retiree du DNS.
# -----------------------------------------------------------------------------
resource "aws_service_discovery_private_dns_namespace" "interne" {
  name = "hrflow.local"
  vpc  = aws_vpc.principal.id
}

resource "aws_service_discovery_service" "service" {
  for_each = var.services

  name = each.key

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.interne.id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}

# -----------------------------------------------------------------------------
# Services ECS
# -----------------------------------------------------------------------------
resource "aws_ecs_service" "service" {
  for_each = var.services

  name            = each.key
  cluster         = aws_ecs_cluster.principal.id
  task_definition = aws_ecs_task_definition.service[each.key].arn
  launch_type     = "FARGATE"
  desired_count   = each.value.replicas

  # Le coeur du deploiement sans interruption : l'ancienne instance n'est
  # retiree qu'une fois la nouvelle declaree disponible.
  #
  # La mesure locale l'a confirme a l'envers : avec une seule instance, le
  # remplacement coupe forcement le service, quel que soit l'orchestrateur
  # (voir scripts/demo-zero-downtime.sh). D'ou la validation `replicas >= 2`.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.prive[*].id
    security_groups  = [aws_security_group.services.id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.service[each.key].arn
  }

  dynamic "load_balancer" {
    for_each = each.value.public ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.bleu.arn
      container_name   = each.key
      container_port   = each.value.port
    }
  }

  # Delai de grace : le temps que la sonde ait une chance de repondre avant
  # qu'ECS ne considere la tache en echec et ne la remplace en boucle.
  health_check_grace_period_seconds = each.value.public ? 60 : null

  lifecycle {
    # CodeDeploy pilote la bascule bleu/vert du service public : Terraform ne
    # doit pas revenir sur ses decisions au prochain apply.
    ignore_changes = [task_definition, load_balancer]
  }
}
