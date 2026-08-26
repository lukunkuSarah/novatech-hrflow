# =============================================================================
# Deploiement — bascule bleu/vert et retour arriere automatique
#
# L'incident du 14 aout 2024 a dure 3 h 07. Pas a cause de la migration : parce
# que personne ne savait l'annuler. Le post-mortem est explicite —
# « Theo tente un rollback manuel. Pas de procedure documentee. »
#
# Ce fichier fait du retour arriere une propriete de l'infrastructure, pas une
# competence individuelle : il se declenche seul si les sondes echouent, sans
# qu'aucun humain n'ait a etre reveille.
# =============================================================================

resource "aws_codedeploy_app" "principal" {
  name             = "hrflow-${var.environnement}"
  compute_platform = "ECS"
}

data "aws_iam_policy_document" "codedeploy_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["codedeploy.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "codedeploy" {
  name               = "hrflow-${var.environnement}-codedeploy"
  assume_role_policy = data.aws_iam_policy_document.codedeploy_assume.json
}

resource "aws_iam_role_policy_attachment" "codedeploy" {
  role       = aws_iam_role.codedeploy.name
  policy_arn = "arn:aws:iam::aws:policy/AWSCodeDeployRoleForECS"
}

resource "aws_codedeploy_deployment_group" "principal" {
  app_name              = aws_codedeploy_app.principal.name
  deployment_group_name = "hrflow-${var.environnement}"
  service_role_arn      = aws_iam_role.codedeploy.arn

  deployment_style {
    deployment_type   = "BLUE_GREEN"
    deployment_option = "WITH_TRAFFIC_CONTROL"
  }

  # ---------------------------------------------------------------------------
  # Bascule progressive
  #
  # 10 % du trafic pendant cinq minutes, puis le reste. Cinq minutes suffisent
  # pour qu'un defaut se manifeste dans les metriques : taux d'erreur, latence
  # au centile 95. Basculer d'un coup exposerait 8 200 utilisateurs a une
  # regression que personne n'aurait encore vue.
  # ---------------------------------------------------------------------------
  deployment_config_name = "CodeDeployDefault.ECSLinear10PercentEvery1Minutes"

  blue_green_deployment_config {
    terminate_blue_instances_on_deployment_success {
      action = "TERMINATE"
      # L'ancienne version reste debout une heure apres la bascule. C'est la
      # fenetre pendant laquelle un retour arriere coute quelques secondes
      # plutot qu'un redeploiement complet.
      termination_wait_time_in_minutes = 60
    }

    deployment_ready_option {
      action_on_timeout = "CONTINUE_DEPLOYMENT"
    }
  }

  # ---------------------------------------------------------------------------
  # Retour arriere automatique
  #
  # Objectif Partech : moins de dix minutes. Ici, il ne depend de personne.
  # ---------------------------------------------------------------------------
  auto_rollback_configuration {
    enabled = true
    events = [
      "DEPLOYMENT_FAILURE",       # les sondes ne passent pas au vert
      "DEPLOYMENT_STOP_ON_ALARM"  # une alarme CloudWatch se declenche
    ]
  }

  alarm_configuration {
    enabled = true
    alarms = [
      aws_cloudwatch_metric_alarm.taux_erreur.alarm_name,
      aws_cloudwatch_metric_alarm.latence.alarm_name,
    ]
    # Si les alarmes elles-memes sont indisponibles, on ne deploie pas : sans
    # signal, impossible de savoir si le deploiement se passe bien.
    ignore_poll_alarm_failure = false
  }

  ecs_service {
    cluster_name = aws_ecs_cluster.principal.name
    service_name = aws_ecs_service.service["api-gateway"].name
  }

  load_balancer_info {
    target_group_pair_info {
      prod_traffic_route {
        listener_arns = [aws_lb_listener.https.arn]
      }

      # Permet de valider la version verte avant de lui envoyer du trafic reel.
      test_traffic_route {
        listener_arns = [aws_lb_listener.test.arn]
      }

      target_group { name = aws_lb_target_group.bleu.name }
      target_group { name = aws_lb_target_group.vert.name }
    }
  }
}
