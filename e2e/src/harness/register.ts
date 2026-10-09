import * as moduleApi from 'node:module';
import { install } from './hook.js';

// Loaded with `node --import`, only by processes the harness spawns.
install(moduleApi);
