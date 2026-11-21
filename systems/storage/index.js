import config from '../../config/config.js';
import { FileStore } from './fileStore.js';
import { MongoStore } from './mongoStore.js';

/** Picks the session store: MongoDB when MONGODB_URI is set, local files otherwise. */
export const createSessionStore = () =>
    config.session.mongoUri
        ? new MongoStore(config.session.mongoUri, { dbName: config.session.mongoDb })
        : new FileStore(config.session.dir);

export { FileStore, MongoStore };
