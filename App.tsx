import { StatusBar } from 'expo-status-bar';
import { useWindowDimensions, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import TornadoGame from './src/components/TornadoGame';

export default function App() {
  const { width, height } = useWindowDimensions();

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={{ flex: 1, backgroundColor: '#0f1620' }}>
        <StatusBar style="light" hidden />
        <TornadoGame width={width} height={height} />
      </View>
    </GestureHandlerRootView>
  );
}
