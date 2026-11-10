import {createWorker} from './adapter.mjs';
import {routes} from './worker.mjs';

// Production is an explicit entry point, never a staging dashboard toggle.
export default createWorker(routes,{releaseEnvironment:'production'});
