# =============================================================================
# Supervision et alertes
#
# Le 15 aout 2024 a 2 h 15, un client d'hotel a telephone au numero d'urgence
# parce qu'il ne pouvait pas acceder aux plannings. La plateforme etait tombee
# a 23 h 47. Le systeme de supervision, c'etait lui.
#
# Objectif : detection en moins de deux minutes, contre 2 h 28 mesurees.
#
# Les alarmes definies ici pilotent aussi le retour arriere automatique de
# CodeDeploy (voir deploiement.tf) : elles ne servent pas seulement a prevenir,
# elles agissent.
# =============================================================================

resource "aws_sns_topic" "alertes" {
  name = "hrflow-${var.environnement}-alertes"
}

resource "aws_sns_topic_subscription" "slack" {
  count = var.alerte_slack_webhook != "" ? 1 : 0

  topic_arn              = aws_sns_topic.alertes.arn
  protocol               = "https"
  endpoint               = var.alerte_slack_webhook
  endpoint_auto_confirms = true
}

# -----------------------------------------------------------------------------
# ERREURS — part des reponses 5xx
# -----------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "taux_erreur" {
  alarm_name        = "hrflow-${var.environnement}-taux-erreur"
  alarm_description = "Plus de dix reponses 5xx par minute. Au-dela, l'incident est en cours, pas a venir."

  namespace   = "AWS/ApplicationELB"
  metric_name = "HTTPCode_Target_5XX_Count"
  statistic   = "Sum"

  # Une minute d'evaluation, deux periodes : deux minutes pour confirmer. En
  # dessous, un incident reseau d'une seconde reveillerait l'astreinte.
  period             = 60
  evaluation_periods = 2
  threshold          = 10
  comparison_operator = "GreaterThanThreshold"

  dimensions = {
    LoadBalancer = aws_lb.principal.arn_suffix
  }

  alarm_actions = [aws_sns_topic.alertes.arn]
  ok_actions    = [aws_sns_topic.alertes.arn]

  # Absence de donnees : le service ne repond plus du tout. C'est une alarme,
  # pas un silence.
  treat_missing_data = "breaching"
}

# -----------------------------------------------------------------------------
# LATENCE — centile 95, pas la moyenne
# -----------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "latence" {
  alarm_name        = "hrflow-${var.environnement}-latence"
  alarm_description = "Centile 95 au-dessus de deux secondes. Une moyenne masquerait la requete lente sur cent — celle que l'utilisateur remarque."

  namespace          = "AWS/ApplicationELB"
  metric_name        = "TargetResponseTime"
  extended_statistic = "p95"

  period              = 60
  evaluation_periods  = 5
  threshold           = 2
  comparison_operator = "GreaterThanThreshold"

  dimensions = {
    LoadBalancer = aws_lb.principal.arn_suffix
  }

  alarm_actions      = [aws_sns_topic.alertes.arn]
  treat_missing_data = "notBreaching"
}

# -----------------------------------------------------------------------------
# DISPONIBILITE — plus aucune instance saine
# -----------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "instances_saines" {
  alarm_name        = "hrflow-${var.environnement}-instances-saines"
  alarm_description = "Aucune instance saine derriere le repartiteur : la plateforme est inaccessible."

  namespace   = "AWS/ApplicationELB"
  metric_name = "HealthyHostCount"
  statistic   = "Minimum"

  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "LessThanThreshold"

  dimensions = {
    LoadBalancer = aws_lb.principal.arn_suffix
    TargetGroup  = aws_lb_target_group.bleu.arn_suffix
  }

  alarm_actions      = [aws_sns_topic.alertes.arn]
  treat_missing_data = "breaching"
}

# -----------------------------------------------------------------------------
# SATURATION — base de donnees
# -----------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "connexions_base" {
  alarm_name        = "hrflow-${var.environnement}-connexions-base"
  alarm_description = "Connexions PostgreSQL proches de la saturation : la base devient injoignable pour tous les services a la fois."

  namespace   = "AWS/RDS"
  metric_name = "DatabaseConnections"
  statistic   = "Maximum"

  period              = 60
  evaluation_periods  = 5
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.principal.id
  }

  alarm_actions = [aws_sns_topic.alertes.arn]
}

resource "aws_cloudwatch_metric_alarm" "stockage_base" {
  alarm_name        = "hrflow-${var.environnement}-stockage-base"
  alarm_description = "Moins de 2 Go disponibles. Une base pleine cesse d'accepter les ecritures — la saturation disque est la cause la plus frequente d'indisponibilite."

  namespace   = "AWS/RDS"
  metric_name = "FreeStorageSpace"
  statistic   = "Minimum"

  period              = 300
  evaluation_periods  = 1
  threshold           = 2147483648
  comparison_operator = "LessThanThreshold"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.principal.id
  }

  alarm_actions = [aws_sns_topic.alertes.arn]
}

# -----------------------------------------------------------------------------
# Sauvegardes
#
# Lors de l'incident P1, la sauvegarde la plus recente datait de 1 h 17 avant
# la panne, et personne ne le savait avant d'en avoir besoin.
# -----------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "sauvegarde" {
  alarm_name        = "hrflow-${var.environnement}-sauvegarde"
  alarm_description = "Aucune sauvegarde recente. L'objectif de perte maximale est de quinze minutes."

  namespace   = "AWS/RDS"
  metric_name = "OldestReplicationSlotLag"
  statistic   = "Maximum"

  period              = 900
  evaluation_periods  = 1
  threshold           = 900
  comparison_operator = "GreaterThanThreshold"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.principal.id
  }

  alarm_actions      = [aws_sns_topic.alertes.arn]
  treat_missing_data = "notBreaching"
}
