import { parentPort } from 'node:worker_threads';
import { createDispatcher } from './dispatch';
import type { HostToWorker, WorkerToHost } from './protocol';
import { WorkerService } from './service';

/** Worker entry: indexing and queries run here, off the extension host thread (N8). */
if (parentPort) {
  const port = parentPort;
  const post = (m: WorkerToHost): void => port.postMessage(m);
  const service = new WorkerService((e) => post({ type: 'event', ...e }));
  const dispatch = createDispatcher(service, post);
  port.on('message', (msg: HostToWorker) => dispatch(msg));
  port.on('close', () => service.close());
}
