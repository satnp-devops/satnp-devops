import { authRoutes } from './routes.js';

export default {
  name: 'auth',
  label: 'Sign-in and security',
  routes: (router) => authRoutes(router),
};
