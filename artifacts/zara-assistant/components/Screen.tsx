import React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';

export function Screen({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  return (
    <View
      style={[
        styles.screen,
        {
          backgroundColor: colors.background,
          paddingTop: Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top,
          paddingBottom: Platform.OS === 'web' ? 34 : insets.bottom,
        },
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({ screen: { flex: 1 } });