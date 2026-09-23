import Constants from 'expo-constants';

export const ZARA_BUNDLE_ID =
  typeof Constants.expoConfig?.extra?.zaraBundleId === 'string'
    ? Constants.expoConfig.extra.zaraBundleId
    : 'zara-bundle-id-missing';

export const ZARA_APP_VERSION = Constants.expoConfig?.version ?? 'unknown';