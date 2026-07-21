package local.flix.tv

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import local.flix.tv.ui.TvRoot
import local.flix.tv.ui.TvViewModel

/** Single-activity Android TV app — 100% D-pad, no touch input assumed
 *  anywhere (see the leanback/touchscreen `<uses-feature>` pair in the
 *  manifest). Playback notification permission is requested lazily by the
 *  shared PlaybackService flow; TV boxes rarely gate it behind a runtime
 *  prompt the way phones do, so it is not requested here explicitly. */
class TvActivity : ComponentActivity() {

    private val vm: TvViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent { TvRoot(vm) }
        // Registered on the dispatcher, NOT via the deprecated onBackPressed
        // override: with targetSdk 36, Android 16+ enables predictive back by
        // default and stops dispatching KEYCODE_BACK to that override — BACK
        // would exit the app instead of popping Detail/Player or returning to
        // Accueil. The dispatcher path works on every API level.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (!vm.back()) {
                    // Nothing left to pop in-app: temporarily step aside and
                    // let the system's default behaviour close the activity.
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    isEnabled = true
                }
            }
        })
    }
}
