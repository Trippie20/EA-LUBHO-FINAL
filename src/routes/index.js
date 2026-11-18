import { authRoutes } from './auth.js';
import { userRoutes } from './users.js';
import { eaRoutes } from './eas.js';
import { accountRoutes } from './accounts.js';
import { licenceRoutes } from './licences.js';
import { sessionRoutes } from './sessions.js';
import { agentRoutes } from './agent.js';
import { miscRoutes } from './misc.js';
import { monitorRoutes } from './monitor.js';

export const routes = [
  ...authRoutes, ...userRoutes, ...eaRoutes, ...accountRoutes,
  ...licenceRoutes, ...sessionRoutes, ...agentRoutes, ...miscRoutes, ...monitorRoutes,
];
