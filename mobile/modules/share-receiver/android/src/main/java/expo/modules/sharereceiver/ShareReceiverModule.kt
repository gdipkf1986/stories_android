package expo.modules.sharereceiver

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ShareReceiverModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ShareReceiver")
    Function("takeSharedText") {
      ShareReceiverStore.takeText()
    }
  }
}
