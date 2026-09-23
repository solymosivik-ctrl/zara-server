import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { useColors } from '@/hooks/useColors';

export function ZaraOrb({ listening = false, thinking = false }: { listening?: boolean; thinking?: boolean }) {
  const colors = useColors();
  const pulse = useRef(new Animated.Value(0)).current;
  const spin = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: listening || thinking ? 650 : 1500,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: listening || thinking ? 650 : 1500,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    const spinLoop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 9000,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    pulseLoop.start();
    spinLoop.start();
    return () => {
      pulseLoop.stop();
      spinLoop.stop();
    };
  }, [listening, pulse, spin]);

  const glowScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1.12] });
  const glowOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.18, listening || thinking ? 0.55 : 0.32] });
  const rotation = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <View style={styles.wrap}>
      <Animated.View
        style={[
          styles.outerGlow,
          {
            backgroundColor: colors.primary,
            opacity: glowOpacity,
            transform: [{ scale: glowScale }],
          },
        ]}
      />
      <Animated.View
        style={[
          styles.orbit,
          { borderColor: colors.primary, transform: [{ rotate: rotation }] },
        ]}
      >
        <View style={[styles.orbitNode, { backgroundColor: colors.accent }]} />
      </Animated.View>
      <View style={[styles.coreHalo, { borderColor: colors.primary }]}>
        <View style={[styles.core, { backgroundColor: colors.primary }]}>
          <View style={[styles.coreSpark, { backgroundColor: colors.accent }]} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: 248, height: 248, alignItems: 'center', justifyContent: 'center' },
  outerGlow: { position: 'absolute', width: 176, height: 176, borderRadius: 88 },
  orbit: {
    position: 'absolute',
    width: 222,
    height: 96,
    borderWidth: 1,
    borderRadius: 112,
    opacity: 0.6,
    transform: [{ rotate: '28deg' }],
  },
  orbitNode: { position: 'absolute', width: 8, height: 8, borderRadius: 4, top: 9, left: 50 },
  coreHalo: {
    width: 142,
    height: 142,
    borderRadius: 71,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(101,232,255,0.06)',
  },
  core: {
    width: 92,
    height: 92,
    borderRadius: 46,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#65E8FF',
    shadowOpacity: 0.5,
    shadowRadius: 24,
    elevation: 12,
  },
  coreSpark: { width: 18, height: 18, borderRadius: 9, opacity: 0.95 },
});