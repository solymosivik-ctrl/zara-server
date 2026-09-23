import { NativeModules, Platform } from 'react-native';

type CloseCalculatorResult = 'closed' | 'not-enabled' | 'not-calculator' | 'failed';

type ZaraAccessibilityNativeModule = {
  isAccessibilityServiceEnabled?: () => Promise<boolean>;
  openAccessibilitySettings?: () => Promise<boolean>;
  requestCloseCalculator?: () => Promise<CloseCalculatorResult>;
};

const nativeModule = NativeModules.ZaraAccessibility as ZaraAccessibilityNativeModule | undefined;

export async function isCalculatorAccessibilityEnabled(): Promise<boolean> {
  if (Platform.OS !== 'android' || !nativeModule?.isAccessibilityServiceEnabled) return false;
  return Boolean(await nativeModule.isAccessibilityServiceEnabled());
}

export async function openCalculatorAccessibilitySettings(): Promise<void> {
  if (Platform.OS !== 'android' || !nativeModule?.openAccessibilitySettings) {
    throw new Error('Az AccessibilityService csak a telepített Android APK-ban érhető el.');
  }
  await nativeModule.openAccessibilitySettings();
}

export async function requestCalculatorClose(): Promise<CloseCalculatorResult> {
  if (Platform.OS !== 'android' || !nativeModule?.requestCloseCalculator) return 'not-enabled';
  return nativeModule.requestCloseCalculator();
}