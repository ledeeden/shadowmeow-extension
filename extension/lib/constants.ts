import releaseConfig from '../release-config.json';

export const CLOUDBASE_ENV = import.meta.env.WXT_CLOUDBASE_ENV || '';
export const CLOUDBASE_REGION = import.meta.env.WXT_CLOUDBASE_REGION || 'ap-shanghai';
export const CLOUDBASE_ACCESS_KEY = import.meta.env.WXT_CLOUDBASE_ACCESS_KEY || undefined;
export const EXTENSION_VERSION = import.meta.env.WXT_RELEASE_VERSION || releaseConfig.version;
export const ADAPTER_VERSION = 'youtube-timedtext-v4';
export const PAGE_CHANNEL = 'shadow-language:youtube:v1';
