import { parentPort, workerData } from 'node:worker_threads';
import { train } from './gbm.mjs';
const { cols, y, names, opts, valid } = workerData;
parentPort.postMessage(train(cols, y, { ...opts, names, valid }));
