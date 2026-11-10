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

    val rawText = intent.getStringExtra(Intent.EXTRA_TEXT)
      ?: intent.clipData?.getItemAt(0)?.text?.toString()
    val title = intent.getStringExtra(Intent.EXTRA_SUBJECT)

    if (!rawText.isNullOrBlank() || !title.isNullOrBlank()) {
      pendingText = when {
        rawText.isNullOrBlank() -> title
        title.isNullOrBlank() || rawText.startsWith(title) -> rawText
        else -> "$title\n$rawText"
      }
      pendingTitle = if (title.isNullOrBlank()) null else title
    }
  }

  fun takeText(): String? {
    val text = pendingText
    pendingText = null
    pendingTitle = null
    return text
  }

  fun takeTitle(): String? {
    val title = pendingTitle
    pendingTitle = null
    return title
  }
}
