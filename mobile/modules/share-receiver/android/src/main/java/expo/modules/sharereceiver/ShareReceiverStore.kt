package expo.modules.sharereceiver

import android.content.Intent

object ShareReceiverStore {
  @Volatile
  private var pendingText: String? = null
  @Volatile
  private var pendingTitle: String? = null

  fun captureIntent(intent: Intent?) {
    if (intent?.action != Intent.ACTION_SEND) return
    if (intent.type != "text/plain") return

    val text = intent.getStringExtra(Intent.EXTRA_TEXT)
      ?: intent.clipData?.getItemAt(0)?.text?.toString()
    if (!text.isNullOrBlank()) {
      pendingText = text
    }

    val title = intent.getStringExtra(Intent.EXTRA_SUBJECT)
    if (!title.isNullOrBlank()) {
      pendingTitle = title
    }
  }

  fun takeText(): String? {
    val text = pendingText
    pendingText = null
    return text
  }

  fun takeTitle(): String? {
    val title = pendingTitle
    pendingTitle = null
    return title
  }
}
