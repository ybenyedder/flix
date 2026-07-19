package local.flix.tv.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import local.flix.core.data.Prefs
import local.flix.core.model.CatalogItem
import local.flix.core.model.LibrarySnapshot
import local.flix.core.model.MovieDetail
import local.flix.core.model.MyListEntry
import local.flix.core.model.ProfileRef
import local.flix.core.model.RatingEntry
import local.flix.core.model.RecommendResult
import local.flix.core.model.ShowDetail
import local.flix.core.model.UserState
import local.flix.core.model.filterForProfile
import local.flix.core.net.FlixApi
import local.flix.core.playback.PlaybackAuth
import local.flix.core.playback.PlayerHolder

// Deliberate near-duplicate of :app's AppViewModel (search UI is dropped —
// the TV browsing model relies on Home rows, per the Phase 9 plan's TvHome
// spec). Living in :tv rather than :core because it composes a Phase/Screen
// state machine, which is UI navigation state, not a reusable non-UI
// primitive — the actual reusable pieces (FlixApi, models, PlayerHolder,
// Prefs) all come straight from :core.

enum class TvPhase { BOOT, CONNECT, PROFILES, LOGIN, LOADING, HOME, ERROR }

sealed interface TvScreen {
    data object Home : TvScreen
    data class Detail(val type: String, val id: Int) : TvScreen
    data class Player(val type: String, val id: Int, val episodeId: Int? = null, val resumeMs: Long = 0L) : TvScreen
}

data class TvUiState(
    val phase: TvPhase = TvPhase.BOOT,
    val serverBase: String = "",
    val connecting: Boolean = false,
    val message: String? = null,

    val profiles: List<ProfileRef> = emptyList(),
    val selectedProfile: String? = null,

    val username: String? = null,
    val avatar: String = "red",
    val isAdmin: Boolean = false,
    val isKids: Boolean = false,

    val library: LibrarySnapshot = LibrarySnapshot.EMPTY,
    val recommend: RecommendResult = RecommendResult.EMPTY,
    val userState: UserState = UserState.EMPTY,

    val screen: TvScreen = TvScreen.Home,
    val backStack: List<TvScreen> = emptyList(),

    val movieDetails: Map<Int, MovieDetail> = emptyMap(),
    val showDetails: Map<Int, ShowDetail> = emptyMap(),
) {
    val visibleMovies: List<CatalogItem> get() = library.movies.filterForProfile(isKids)
    val visibleShows: List<CatalogItem> get() = library.shows.filterForProfile(isKids)
}

class TvViewModel(app: Application) : AndroidViewModel(app) {

    private val prefs = Prefs(app)
    val api = FlixApi()
    val player = PlayerHolder(app)

    private val _ui = MutableStateFlow(TvUiState())
    val ui: StateFlow<TvUiState> = _ui.asStateFlow()

    init {
        player.connect()
        boot()
    }

    override fun onCleared() {
        player.release()
        super.onCleared()
    }

    private fun boot() {
        viewModelScope.launch {
            val p = prefs.load()
            if (p.serverBase.isBlank()) {
                _ui.update { it.copy(phase = TvPhase.CONNECT) }
                return@launch
            }
            api.configure(p.serverBase, p.token)
            PlaybackAuth.token = p.token
            _ui.update { it.copy(serverBase = p.serverBase) }
            if (p.token.isNullOrBlank()) {
                loadProfiles(p.serverBase)
                return@launch
            }
            val status = api.status()
            if (status.ok) {
                api.setToken(status.token ?: p.token)
                PlaybackAuth.token = status.token ?: p.token
                prefs.setSession(status.token ?: p.token, status.username, status.avatar, status.isAdmin, status.isKids)
                _ui.update { it.copy(username = status.username, avatar = status.avatar, isAdmin = status.isAdmin, isKids = status.isKids) }
                loadHome()
            } else if (!status.serverReachable) {
                // Transient outage (NAS rebooting, new DHCP lease…) must NOT
                // nuke the stored session — land on the connect screen so the
                // user can retry or repoint the address, and keep the token
                // for the next successful boot.
                _ui.update { it.copy(phase = TvPhase.CONNECT, connecting = false, message = "Serveur injoignable. Vérifiez l'adresse et le réseau.") }
            } else {
                // The SERVER rejected the token — only then is the session dead.
                prefs.clearSession()
                loadProfiles(p.serverBase)
            }
        }
    }

    fun connect(rawBase: String) {
        val base = rawBase.trim()
        if (base.isBlank()) return
        viewModelScope.launch {
            // SECURITY: pointing at a (possibly new / untrusted) server must never
            // leak the PREVIOUS host's session bearer. Drop it BEFORE the first
            // request to the new base — otherwise the api.health() probe below
            // would carry the old Authorization header to a host it doesn't belong
            // to. Same guard as the mobile AppViewModel.connect().
            api.setToken(null)
            PlaybackAuth.token = null
            prefs.clearSession()
            _ui.update { it.copy(connecting = true, message = null) }
            val ok = api.health(base)
            if (!ok) {
                _ui.update { it.copy(connecting = false, message = "Serveur injoignable. Vérifiez l'adresse et le réseau.") }
                return@launch
            }
            val normalized = FlixApi.normalizeBase(base)
            api.configure(normalized, null)
            prefs.setServer(normalized)
            _ui.update { it.copy(serverBase = normalized, connecting = false) }
            loadProfiles(normalized)
        }
    }

    fun changeServer() {
        _ui.update { it.copy(phase = TvPhase.CONNECT, message = null, selectedProfile = null) }
    }

    private fun loadProfiles(base: String) {
        viewModelScope.launch {
            val profiles = api.accounts(base)
            _ui.update { it.copy(profiles = profiles, phase = TvPhase.PROFILES, message = null) }
        }
    }

    fun selectProfile(username: String) {
        _ui.update { it.copy(selectedProfile = username, phase = TvPhase.LOGIN, message = null) }
    }

    fun backToProfiles() {
        _ui.update { it.copy(selectedProfile = null, phase = TvPhase.PROFILES, message = null) }
    }

    fun login(password: String) {
        val username = _ui.value.selectedProfile ?: return
        viewModelScope.launch {
            _ui.update { it.copy(connecting = true, message = null) }
            val result = api.login(_ui.value.serverBase, username, password)
            if (!result.ok || result.token == null) {
                _ui.update { it.copy(connecting = false, message = result.error ?: "Connexion impossible") }
                return@launch
            }
            api.setToken(result.token)
            PlaybackAuth.token = result.token
            prefs.setSession(result.token, result.username ?: username, result.avatar, result.isAdmin, result.isKids)
            _ui.update {
                it.copy(connecting = false, username = result.username ?: username, avatar = result.avatar, isAdmin = result.isAdmin, isKids = result.isKids)
            }
            loadHome()
        }
    }

    fun loadHome() {
        viewModelScope.launch {
            _ui.update { it.copy(phase = TvPhase.LOADING) }
            try {
                val libraryDef = async { api.library() }
                val recoDef = async { api.recommend() }
                val stateDef = async { api.userState() }
                val library = libraryDef.await()
                val reco = recoDef.await()
                val state = stateDef.await()
                _ui.update { it.copy(phase = TvPhase.HOME, library = library, recommend = reco, userState = state, message = null) }
            } catch (t: Throwable) {
                _ui.update { it.copy(phase = TvPhase.ERROR, message = "Impossible de charger la bibliothèque : ${t.message}") }
            }
        }
    }

    fun refreshRecommend() {
        viewModelScope.launch { _ui.update { it.copy(recommend = api.recommend()) } }
    }

    fun navigate(screen: TvScreen) {
        _ui.update { it.copy(backStack = it.backStack + it.screen, screen = screen) }
    }

    fun back(): Boolean {
        val stack = _ui.value.backStack
        if (stack.isEmpty()) return false
        _ui.update { it.copy(screen = stack.last(), backStack = stack.dropLast(1)) }
        return true
    }

    fun openDetail(type: String, id: Int) {
        navigate(TvScreen.Detail(type, id))
        viewModelScope.launch {
            if (type == "movie" && !_ui.value.movieDetails.containsKey(id)) {
                api.movieDetail(id)?.let { d -> _ui.update { it.copy(movieDetails = it.movieDetails + (id to d)) } }
            } else if (type == "show" && !_ui.value.showDetails.containsKey(id)) {
                api.showDetail(id)?.let { d -> _ui.update { it.copy(showDetails = it.showDetails + (id to d)) } }
            }
        }
    }

    fun play(type: String, id: Int, episodeId: Int? = null, resumeMs: Long = 0L) {
        navigate(TvScreen.Player(type, id, episodeId, resumeMs))
    }

    fun isInMyList(type: String, id: Int): Boolean = _ui.value.userState.myList.any { it.itemType == type && it.itemId == id }
    fun ratingFor(type: String, id: Int): Int? = _ui.value.userState.ratings.firstOrNull { it.itemType == type && it.itemId == id }?.value

    fun toggleMyList(type: String, id: Int) {
        val add = !isInMyList(type, id)
        _ui.update { state ->
            val filtered = state.userState.myList.filterNot { it.itemType == type && it.itemId == id }
            state.copy(userState = state.userState.copy(myList = if (add) filtered + MyListEntry(type, id) else filtered))
        }
        viewModelScope.launch { api.toggleMyList(type, id, add); refreshRecommend() }
    }

    fun setRating(type: String, id: Int, value: Int) {
        _ui.update { state ->
            val filtered = state.userState.ratings.filterNot { it.itemType == type && it.itemId == id }
            state.copy(userState = state.userState.copy(ratings = if (value == 0) filtered else filtered + RatingEntry(type, id, value)))
        }
        viewModelScope.launch { api.setRating(type, id, value); refreshRecommend() }
    }

    fun saveProgress(itemType: String, itemId: Int, position: Double, duration: Double, mediaFileId: Int?) {
        viewModelScope.launch { api.setProgress(itemType, itemId, position, duration, mediaFileId) }
    }

    fun recordWatchEvent(itemType: String, itemId: Int, kind: String, ratio: Double, seconds: Double) {
        viewModelScope.launch { api.recordWatchEvent(itemType, itemId, kind, ratio, seconds) }
    }

    /** Server-side HLS session teardown, launched from the ViewModel scope: the
     *  composable's rememberCoroutineScope is already cancelled inside
     *  onDispose, so a launch{} there died before the DELETE was ever sent and
     *  the server-side ffmpeg lived on until the idle reaper. */
    fun endPlaySession(sessionId: String) {
        viewModelScope.launch { api.endSession(sessionId) }
    }
}
