import { useRef, type ReactNode } from 'react';
import { Dimensions, PanResponder, StyleSheet, View } from 'react-native';

interface Props {
  /** 手势命中后回调（通常是返回上一页） */
  onSwipeBack: () => void;
  children: ReactNode;
}

/** 屏幕左右边缘的感应区宽度（dp），手指落在这个范围内才启动手势 */
const EDGE_WIDTH = 30;
/** 手势启动所需的最小横向位移（dp） */
const START_DISTANCE = 14;
/** 触发返回所需的有效位移（dp），或快速轻扫（速度阈值） */
const COMMIT_DISTANCE = 60;
const FLING_VELOCITY = 0.6;

/** 边缘侧滑返回：从屏幕左缘向右滑、或右缘向左滑，均触发 onSwipeBack。
 *  纯 JS 实现（PanResponder），不引入原生依赖；只拦截横向手势，
 *  纵向滚动不受影响。 */
export default function EdgeSwipeBack({ onSwipeBack, children }: Props) {
  /** 手指起点是否落在边缘感应区（以及哪一侧） */
  const edge = useRef<'left' | 'right' | null>(null);
  /** 本次手势是否已触发过，避免一次滑动重复回调 */
  const fired = useRef(false);

  const inEdge = (pageX: number) => {
    const { width } = Dimensions.get('window'); // 实时取，转屏后仍正确
    return pageX <= EDGE_WIDTH ? 'left' : pageX >= width - EDGE_WIDTH ? 'right' : null;
  };

  const panResponder = useRef(
    PanResponder.create({
      // 捕获阶段记录起点位置，但不抢占（return false），让子视图正常工作
      onStartShouldSetPanResponderCapture: (evt) => {
        const { pageX } = evt.nativeEvent;
        edge.current = inEdge(pageX);
        fired.current = false;
        return false;
      },
      // 移动阶段：起点在边缘、且是「离开边缘」的横向位移时才抢过来
      onMoveShouldSetPanResponderCapture: (_evt, g) => {
        if (!edge.current || fired.current) return false;
        const horizontal = Math.abs(g.dx) > START_DISTANCE && Math.abs(g.dx) > Math.abs(g.dy) * 1.5;
        if (!horizontal) return false;
        const awayFromEdge = edge.current === 'left' ? g.dx > 0 : g.dx < 0;
        if (!awayFromEdge) return false;
        return true;
      },
      onPanResponderRelease: (_evt, g) => {
        const awayFromEdge = edge.current === 'left' ? g.dx > 0 : g.dx < 0;
        const hit =
          edge.current !== null &&
          awayFromEdge &&
          (Math.abs(g.dx) > COMMIT_DISTANCE || Math.abs(g.vx) > FLING_VELOCITY) &&
          Math.abs(g.dx) > Math.abs(g.dy);
        if (hit && !fired.current) {
          fired.current = true;
          onSwipeBack();
        }
        edge.current = null;
      },
      onPanResponderTerminate: () => {
        edge.current = null;
      },
    }),
  ).current;

  return (
    <View style={styles.fill} {...panResponder.panHandlers}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
});
