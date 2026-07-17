package local.flix.tv

import android.os.Bundle
import androidx.activity.ComponentActivity
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
    }

    override fun onBackPressed() {
        if (!vm.back()) {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }
}
