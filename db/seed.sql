-- =============================================================================
-- Jeu de données de démonstration
--
-- Destiné exclusivement au développement local et à la démonstration.
-- Deux entreprises distinctes sont créées volontairement : elles permettent de
-- démontrer le cloisonnement multi-locataire (SEC-08) en tentant, depuis un
-- compte de NovaTech Client A, d'accéder aux données de Client B.
--
-- Les empreintes de mot de passe correspondent toutes à : DemoHRFlow2024!
-- (bcrypt, coût 10). Ce jeu ne doit jamais être chargé ailleurs qu'en local.
-- =============================================================================

INSERT INTO companies (id, nom, siret) VALUES
  (100, 'Atelier Mercure SARL', '81234567800021'),
  (200, 'Groupe Lumen SAS',     '79876543200018')
ON CONFLICT (id) DO NOTHING;

SELECT setval('companies_id_seq', 300, false);

-- -----------------------------------------------------------------------------
-- Salariés
-- -----------------------------------------------------------------------------
INSERT INTO employees (id, company_id, matricule, nom, prenom, email, salaire_mensuel_brut, jours_conges_acquis, date_entree) VALUES
  (10, 100, 'MER-001', 'Bouaziz',   'Karim',   'karim.bouaziz@mercure.example',   4200.00, 25, '2019-03-01'),
  (11, 100, 'MER-002', 'Lefevre',   'Camille', 'camille.lefevre@mercure.example', 2537.83, 25, '2021-09-13'),
  (12, 100, 'MER-003', 'Al-Rashid', 'Mohamed', 'mohamed.alrashid@mercure.example', 3000.00, 25, '2022-01-10'),
  (20, 200, 'LUM-001', 'Nakamura',  'Yuki',    'yuki.nakamura@lumen.example',      3800.00, 25, '2020-06-15')
ON CONFLICT (id) DO NOTHING;

SELECT setval('employees_id_seq', 100, false);

-- -----------------------------------------------------------------------------
-- Comptes
-- -----------------------------------------------------------------------------
INSERT INTO users (id, company_id, employee_id, email, password_hash, role) VALUES
  (1, 100, 10, 'karim.bouaziz@mercure.example',   '$2a$10$6DDphuYGCLLT1i1jdM9BR.zEIrr6eEaabrt5T9mxV8.TwXbHZZ9LS', 'admin'),
  (2, 100, 11, 'camille.lefevre@mercure.example', '$2a$10$6DDphuYGCLLT1i1jdM9BR.zEIrr6eEaabrt5T9mxV8.TwXbHZZ9LS', 'rh'),
  (3, 100, 12, 'mohamed.alrashid@mercure.example','$2a$10$6DDphuYGCLLT1i1jdM9BR.zEIrr6eEaabrt5T9mxV8.TwXbHZZ9LS', 'salarie'),
  (4, 200, 20, 'yuki.nakamura@lumen.example',     '$2a$10$6DDphuYGCLLT1i1jdM9BR.zEIrr6eEaabrt5T9mxV8.TwXbHZZ9LS', 'rh')
ON CONFLICT (id) DO NOTHING;

SELECT setval('users_id_seq', 100, false);

-- -----------------------------------------------------------------------------
-- Congés
-- -----------------------------------------------------------------------------
INSERT INTO conges (company_id, employee_id, date_debut, date_fin, nombre_jours, motif, statut) VALUES
  (100, 12, '2024-07-08', '2024-07-19', 10, 'Congés d''été',   'approuve'),
  (100, 12, '2024-12-23', '2024-12-27',  3, 'Fêtes de fin d''année', 'en_attente'),
  (100, 11, '2024-05-06', '2024-05-10',  5, 'Congés',          'approuve')
ON CONFLICT DO NOTHING;
