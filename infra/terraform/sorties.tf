# =============================================================================
# Sorties — valeurs consommees par le pipeline et par l'exploitation
# =============================================================================

output "adresse_publique" {
  description = "Nom DNS du repartiteur"
  value       = aws_lb.principal.dns_name
}

output "cluster_ecs" {
  description = "Nom du cluster — utilise par les etapes 4 et 5 du pipeline"
  value       = aws_ecs_cluster.principal.name
}

output "application_codedeploy" {
  description = "Application CodeDeploy pilotant la bascule bleu/vert"
  value       = aws_codedeploy_app.principal.name
}

output "groupe_deploiement" {
  description = "Groupe de deploiement CodeDeploy"
  value       = aws_codedeploy_deployment_group.principal.deployment_group_name
}

output "secret_application" {
  description = "ARN du secret applicatif. L'ARN n'est pas sensible ; son contenu l'est, et il ne sort jamais d'ici."
  value       = aws_secretsmanager_secret.application.arn
}

output "point_terminaison_base" {
  description = "Point de terminaison PostgreSQL — reseau prive uniquement"
  value       = aws_db_instance.principal.endpoint
  sensitive   = true
}

output "bucket_cv" {
  description = "Stockage des CV de candidats"
  value       = aws_s3_bucket.cv.bucket
}

output "sujet_alertes" {
  description = "Sujet SNS des alertes"
  value       = aws_sns_topic.alertes.arn
}

# Rend explicite ce qui est deploye : le systeme audite ne permettait pas de
# savoir quelle version tournait (constat CIC-10).
output "version_deployee" {
  description = "Empreinte de commit actuellement deployee"
  value       = var.version_image
}
