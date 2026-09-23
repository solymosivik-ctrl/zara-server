import { Platform } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';
import { requestCalculatorClose } from '@/services/calculator-accessibility';

export type AndroidAppCommand = 'calculator' | 'close-calculator';

const calculatorPackages = [
  'com.google.android.calculator',
  'com.sec.android.app.popupcalculator',
  'com.samsung.android.app.calculator',
  'com.miui.calculator',
  'com.android.calculator2',
  'com.oneplus.calculator',
  'com.coloros.calculator',
  'com.vivo.calculator',
  'com.huawei.calculator',
  'com.motorola.calculator2',
];

function normalizeCommand(value: string): string {
  return value
    .toLocaleLowerCase('hu-HU')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseAndroidAppCommand(value: string): AndroidAppCommand | null {
  const normalized = normalizeCommand(value);
  // Speech recognition sometimes turns "számológépet" into
  // "számítógépet"; treat that common voice error as the calculator command.
  const mentionsCalculator =
    /\b(?:szamologep(?:et)?|szamitogep(?:et)?|kalkulator(?:t)?|szamolot)\b/.test(normalized);
  const asksToClose =
    /\b(?:zard be|csukd be|zarj be|zarjuk be|lepj ki|fejezd be)\b/.test(normalized);
  const asksToOpen = /\b(?:nyisd meg|inditsd el|inditsd|nyisd ki|nyissa meg|nyit[sa]d meg)\b/.test(
    normalized,
  );

  if (mentionsCalculator && asksToClose) {
    return 'close-calculator';
  }

  if (
    mentionsCalculator &&
    (asksToOpen ||
      /\b(?:szamologep|szamitogep|kalkulator) megnyitasa\b/.test(normalized))
  ) {
    return 'calculator';
  }
  return null;
}

export async function launchAndroidApp(command: AndroidAppCommand): Promise<string> {
  if (Platform.OS !== 'android') {
    return 'Ezt az Android-alkalmazást csak Android telefonon tudom megnyitni.';
  }

  if (command === 'calculator') {
    for (const packageName of calculatorPackages) {
      try {
        // Package visibility is declared in AndroidManifest.xml. This check
        // prevents a missing first fallback from being reported as launched.
        const icon = await IntentLauncher.getApplicationIconAsync(packageName);
        if (icon) {
          IntentLauncher.openApplication(packageName);
          return 'Megnyitom a számológépet.';
        }
      } catch {
        // The package is not installed or is not visible; try the next one.
      }
    }

    // Let Android resolve an installed calculator that uses a package name not
    // covered above. The timeout is only a success signal after the Intent
    // call has remained pending, because Android resolves the Promise when
    // the launched activity returns to Zara.
    if (
      await launchCalculatorIntent({
        category: 'android.intent.category.APP_CALCULATOR',
      })
    ) {
      return 'Megnyitom a számológépet.';
    }

    return 'Nem találtam számológép alkalmazást ezen a telefonon.';
  }

  if (command === 'close-calculator') {
    const result = await requestCalculatorClose();
    if (result === 'closed') return 'Bezártam a számológépet.';
    if (result === 'not-enabled') {
      return 'A számológép hangos bezárásához engedélyezd a Zara AccessibilityService szolgáltatását a Beállításokban.';
    }
    if (result === 'not-calculator') {
      return 'A számológép nincs előtérben, ezért nem zártam be.';
    }
    return 'A számológép bezárását Android nem erősítette meg, ezért nem mondom, hogy sikerült.';
  }

  return 'Ezt az alkalmazást még nem tudom megnyitni.';
}

type CalculatorIntent = {
  packageName?: string;
  category: string;
};

async function launchCalculatorIntent(intent: CalculatorIntent): Promise<boolean> {
  try {
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (started: boolean) => {
        if (settled) return;
        settled = true;
        resolve(started);
      };
      const timeout = setTimeout(
        () => settle(Boolean(intent.packageName)),
        intent.packageName ? 900 : 1200,
      );

      void IntentLauncher.startActivityAsync('android.intent.action.MAIN', intent)
        .then(() => {
          clearTimeout(timeout);
          settle(true);
        })
        .catch(() => {
          clearTimeout(timeout);
          settle(false);
        });
    });
  } catch {
    return false;
  }
}