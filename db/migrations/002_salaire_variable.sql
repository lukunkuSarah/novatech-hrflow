-- =============================================================================
-- Ajout de la rémunération variable
--
-- C'est la migration que Théo a exécutée à 23 h 30 le 14 août 2024, via la
-- route HTTP `POST /paie/migrate`, en production, sans sauvegarde et sans test.
-- Elle a corrompu la table `employees` et provoqué 3 h 07 de coupure.
--
-- Le contenu fonctionnel est identique. Ce qui change, c'est tout le reste :
--
--   1. c'est un fichier versionné, relu et testé sur staging avant production ;
--   2. il est appliqué par un conteneur éphémère, en dehors des processus qui
--      servent le trafic ;
--   3. une sauvegarde vérifiée est prise juste avant (scripts/backup.sh) ;
--   4. la mise à jour de masse a disparu.
--
-- Sur ce dernier point : la version d'origine se terminait par
--
--     UPDATE employees SET updated_at = NOW();
--
-- soit une réécriture de toutes les lignes de la table, sans clause WHERE,
-- posant un verrou sur l'intégralité de `employees` pendant toute la durée de
-- l'opération — aux heures où les plannings du lendemain étaient consultés.
-- Cette instruction n'apportait rien : elle est supprimée.
--
-- Compatibilité ascendante : la colonne est ajoutée avec une valeur par défaut
-- et n'est pas encore lue par le code. La version précédente de l'application
-- continue donc de fonctionner, ce qui rend le retour arrière applicatif sûr.
-- =============================================================================

ALTER TABLE employees
    ADD COLUMN IF NOT EXISTS salaire_variable NUMERIC(10, 2) NOT NULL DEFAULT 0
    CONSTRAINT employees_salaire_variable_positif CHECK (salaire_variable >= 0);

COMMENT ON COLUMN employees.salaire_variable IS
    'Part variable mensuelle. Non encore prise en compte dans le calcul de paie : '
    'le barème doit être validé par un expert-comptable au préalable (QUA-02).';
