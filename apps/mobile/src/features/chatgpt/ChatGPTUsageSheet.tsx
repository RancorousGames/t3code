import { useAtomValue } from "@effect/atom-react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { environmentPresentations } from "../../state/presentation";
import { buildSubscriptionUsageSnapshot, subscriptionUsageTimeline } from "../../widgets/subscriptionUsageSnapshot";
import { useRefreshLimits } from "../usage/UsageLimitsSection";

export function ChatGPTUsageSheet({
  visible,
  onClose,
}: {
  readonly visible: boolean;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);

  const { now, refreshing, failedLabels, refresh } = useRefreshLimits(null, visible);
  const snapshot = subscriptionUsageTimeline(buildSubscriptionUsageSnapshot(presentations, "", 2), now)[0]!.props;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View className="flex-1 justify-end bg-black/60">
        <Pressable accessibilityLabel="Dismiss T3 usage" onPress={onClose} className="flex-1" />
        <View
          accessibilityViewIsModal
          className="rounded-t-3xl border-t border-border bg-sheet px-5 pt-5"
          style={{ maxHeight: "85%", paddingBottom: Math.max(insets.bottom, 20) }}
        >
          <View className="mb-4 flex-row items-center justify-between gap-4">
            <Text className="text-lg font-semibold text-foreground">T3 usage</Text>
            <View className="flex-row items-center gap-4">
              <Pressable accessibilityRole="button" onPress={() => void refresh()} disabled={refreshing}>
                <Text className="text-sm font-t3-medium text-primary">
                  {refreshing ? "Refreshing…" : "Refresh"}
                </Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Close T3 usage" onPress={onClose}>
                <Text className="text-sm font-t3-medium text-foreground">Close</Text>
              </Pressable>
            </View>
          </View>
          <ScrollView className="min-h-0" showsVerticalScrollIndicator={false}>
            {failedLabels.length > 0 ? (
              <Text accessibilityRole="alert" className="mb-3 text-sm text-warning-foreground">
                Could not refresh {failedLabels.join(", ")}. Usage may be outdated.
              </Text>
            ) : null}
            {snapshot.providers.length === 0 ? (
              <Text className="py-8 text-center text-sm text-foreground-muted">
                Connect a provider to see subscription usage.
              </Text>
            ) : (
              <View className="gap-4 pb-4">
                {snapshot.providers.map((provider) => (
                  <View key={provider.name} className="gap-3 rounded-xl border border-border bg-subtle p-4">
                    <View className="flex-row items-center justify-between gap-2">
                      <Text className="text-base font-semibold text-foreground">{provider.name}</Text>
                      <Text className="text-xs text-foreground-muted">{provider.detail}</Text>
                    </View>
                    {provider.windows.map((window) => (
                      <View key={`${window.kind ?? window.label}:${window.label}`} className="gap-1.5">
                        <View className="flex-row items-center justify-between">
                          <Text className="text-sm text-foreground">{window.label}</Text>
                          <Text className="text-sm font-semibold tabular-nums text-foreground">
                            {window.remaining}% left
                          </Text>
                        </View>
                        <View className="h-2 overflow-hidden rounded-full bg-border">
                          <View
                            className="h-full rounded-full bg-primary"
                            style={{ width: `${Math.max(0, Math.min(window.remaining, 100))}%` }}
                          />
                        </View>
                        <Text className="text-xs text-foreground-muted">{window.reset}</Text>
                      </View>
                    ))}
                  </View>
                ))}
              </View>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
