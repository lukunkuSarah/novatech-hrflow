'use strict'

/**
 * @hrflow/shared — briques transverses des services HRFlow.
 *
 * Ce paquet existe pour une raison précise : dans le système audité, chaque
 * service réimplémentait (ou omettait) l'authentification, la gestion
 * d'erreurs et la configuration. Les omissions étaient donc invisibles.
 * Centraliser rend l'oubli impossible : un service qui n'importe pas
 * `requireAuth` se repère en une ligne à la revue.
 */

module.exports = {
  ...require('./config'),
  ...require('./logger'),
  ...require('./errors'),
  ...require('./auth'),
  ...require('./http'),
  ...require('./health'),
  ...require('./db'),
  ...require('./validate'),
  ...require('./metriques'),
  ...require('./drapeaux'),
  ...require('./bootstrap'),
  ...require('./testing')
}
