# Post-mortem Incident P1 — 14/15 août 2024

**Rédigé par** : Karim Bouaziz (CEO)
**Date de rédaction** : 16 août 2024
**Durée de l'incident** : 3h07 (23h47 → 02h54)

## Résumé

Coupure totale de la plateforme HRFlow pendant 3h07 dans la nuit du 14 au 15 août 2024.
Cause : migration base de données déclenchée manuellement en production à 23h30.

## Chronologie

- **23h30** : Théo lance une migration SQL en prod via la route `/paie/migrate` pour ajouter une colonne
- **23h47** : La migration corrompt la table `employees`. Toute la plateforme tombe.
- **23h47** : Aucune alerte automatique. Personne n'est notifié.
- **02h15** : Mohamed Al-Rashid (hôtel Mercure Lyon) appelle le numéro d'urgence car il ne peut pas accéder aux plannings du lendemain matin.
- **02h22** : Karim réveille Théo par téléphone.
- **02h25** : Théo tente un rollback manuel. Pas de procédure documentée.
- **02h54** : Restauration d'un backup de 22h30. Perte de 1h17 de données.
- **03h00** : Services redémarrés. Plateforme de nouveau disponible.

## Impact

- 8 200 utilisateurs impactés
- 3 clients ont résilié dans les 2 semaines suivantes
- 2 mises en demeure reçues
- Déclaration CNIL en cours d'examen
- Départ du CTO le 26 août

## Causes racines

1. Route de migration accessible sans authentification
2. Aucun test avant exécution en production
3. Aucun backup automatique récent (le dernier datait de 22h30)
4. Aucun système de monitoring / alerting
5. Procédure de rollback inexistante

## Actions décidées

- [ ] Sécuriser ou supprimer la route `/paie/migrate`
- [ ] Mettre en place des backups automatiques toutes les heures
- [ ] Créer une procédure de rollback documentée
- [ ] Implémenter du monitoring
- [ ] Ne plus déployer en prod après 18h sans validation

**Status** : aucune action réalisée à ce jour (26/08/2024)
— Le CTO est parti avant de pouvoir agir. Karim
