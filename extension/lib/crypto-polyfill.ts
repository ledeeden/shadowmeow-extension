import { installAbortSignalPolyfill, installWebCryptoPolyfill } from '@shadow-language/contracts';

// Shared by web pages, extension pages, and service workers. Non-secure or
// legacy runtimes may lack crypto.subtle.digest / crypto.randomUUID.
installWebCryptoPolyfill();
// Older browsers and some page contexts lack AbortSignal.timeout / .any.
installAbortSignalPolyfill();
