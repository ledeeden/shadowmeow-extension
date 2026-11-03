import '../lib/crypto-polyfill';
import { startRuntimeService } from '../lib/runtime-service';

export default defineBackground(startRuntimeService);
