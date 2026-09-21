"""
Helixa Space — backend

v0.1  Landing + create/join
v0.2  Two-person WebRTC video/audio call
v0.3  Multiple participants + meeting rooms
v0.4  Controls + chat + participants panel
v0.5  Screen sharing + fullscreen + spotlight
v0.6  Media pipeline fixes, roles (host/co-host/participant),
      real participant actions, Space ID + Space IDL access
v0.7  Focus/Pin/Spotlight separation, mobile dock, screen-share fixes
v0.8  Space lifecycle (created/active/ended), server-issued host/session
      tokens, Co-host Key, admission mode, block-list, End Meeting

The Python server only handles signaling (who's in the room, and relaying
WebRTC offer/answer/ICE messages) plus chat/control events. Media itself
(camera, mic, screen share) flows peer-to-peer over WebRTC and never
touches this server.
"""

import io
import os
import random
import re
import secrets
import time

from flask import Flask, render_template, request, jsonify, send_file, url_for

try:
    import qrcode
    QR_AVAILABLE = True
except ImportError:
    # qrcode/Pillow aren't installed yet — the app still runs, the QR
    # endpoint just reports itself as unavailable instead of crashing.
    QR_AVAILABLE = False
from flask_socketio import SocketIO, emit, join_room, leave_room

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "helixa-space-dev-secret")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# ---------------------------------------------------------------------------
# In-memory room state (fine for this stage; move to SQLite/Redis later if
# the process needs to survive restarts or scale across workers).
# ---------------------------------------------------------------------------
# rooms_state[space_id] = {
#     "name": str,
#     "password": str | None,
#     "idl": str | None,            # Space IDL — passwordless quick-join code
#     "co_host_key": str | None,    # separate secret, lets a holder start/co-host
#     "lifecycle": "created" | "active" | "ended",
#     "host_token": str,            # server-issued authority token for the
#                                    # ORIGINAL host — never the display name
#     "host_sid": str | None,       # current connected host's socket id, if any
#     "admission_mode": bool,       # True = participants wait for admission
#     "blocked_tokens": set[str],   # participant_tokens denied re-entry
#     "pending_admission": { sid: {"name": str, "participant_token": str} },
#     "created_at": float,
#     "participants": {
#         sid: {
#             "name": str,
#             "participant_token": str,  # server-issued, survives refresh via client storage
#             "mic": bool,
#             "cam": bool,
#             "hand_raised": bool,
#             "role": "host" | "co-host" | "participant",
#             "spotlighted": bool,
#             "screen_sharing": bool,
#         }
#     },
# }
rooms_state = {}
idl_index = {}  # idl -> space_id, kept in sync with rooms_state for O(1) lookup

ROLE_HOST = "host"
ROLE_COHOST = "co-host"
ROLE_PARTICIPANT = "participant"

LIFECYCLE_CREATED = "created"   # host configured the Space but hasn't started it
LIFECYCLE_ACTIVE = "active"     # meeting is running, joins are allowed
LIFECYCLE_ENDED = "ended"       # host explicitly ended it — cannot be rejoined

ID_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no ambiguous chars
VALID_SPACE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$")


def gen_space_idl():
    """Space IDL: a short passwordless quick-join code. Generated with the
    same secure random source as the Space ID, checked for collisions
    against every currently active IDL before being handed out."""
    while True:
        candidate = "HX" + "".join(random.choices(ID_CHARS, k=6))
        if candidate not in idl_index:
            return candidate


def gen_co_host_key():
    """A short, separate secret from the meeting password. Anyone holding
    it can start an unstarted Space and act as co-host."""
    return "CH-" + "".join(random.choices(ID_CHARS, k=4)) + "-" + "".join(random.choices(ID_CHARS, k=4))


def gen_secure_token():
    """Server-issued authority/session token. This — never a typed display
    name — is what the server trusts to recognize a returning host or a
    previously-removed participant."""
    return secrets.token_urlsafe(24)


def _new_room(name, password=None, idl=None, co_host_key=None):
    return {
        "name": name,
        "password": password or None,
        "idl": idl,
        "co_host_key": co_host_key,
        "lifecycle": LIFECYCLE_CREATED,
        "host_token": gen_secure_token(),
        "host_sid": None,
        "admission_mode": False,
        "blocked_tokens": set(),
        "blocked_names": {},  # participant_token -> name at time of block, for the management UI
        "pending_admission": {},
        "blocked_retry_notified_at": {},  # participant_token -> last notify time, for rate limiting
        "created_at": time.time(),
        "participants": {},
    }


BLOCKED_RETRY_NOTIFY_COOLDOWN = 30  # seconds between "removed participant is trying to join" notices per person


def _can_moderate(info):
    """Host and co-host may perform moderation actions; plain
    participants may not."""
    return info["role"] in (ROLE_HOST, ROLE_COHOST)


def _is_host(info):
    return info["role"] == ROLE_HOST


def _find_room_for_sid(sid):
    for space_id, room in rooms_state.items():
        if sid in room["participants"]:
            return space_id, room
    return None, None


def _room_public_state(room):
    """Everything about a room that's safe to hand to any client asking
    about it before they've joined (e.g. the join page checking whether a
    Space exists and what state it's in)."""
    return {
        "exists": True,
        "name": room["name"],
        "locked": bool(room.get("password")),
        "lifecycle": room["lifecycle"],
        "admissionMode": room["admission_mode"],
        "participantCount": len(room["participants"]),
    }


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/create")
def create():
    return render_template("create.html")


@app.route("/join")
def join():
    return render_template("join.html")


@app.route("/space/<space_id>/details")
def space_details(space_id):
    return render_template("space-details.html", space_id=space_id)


@app.route("/meeting/<space_id>")
def meeting(space_id):
    return render_template("meeting.html", space_id=space_id)


# ---------------------------------------------------------------------------
# REST helpers — Space ID (password-protected) creation/lookup, Space IDL
# (passwordless quick-join) suggestion/lookup, and Space lifecycle state.
# ---------------------------------------------------------------------------

def validate_space_id(raw):
    """Returns (clean_id, error_message). error_message is None on success.
    The host chooses the Space ID — this only checks format and
    availability, it never invents a replacement value."""
    candidate = (raw or "").strip()
    if not candidate:
        return None, "Space ID is required."
    if not VALID_SPACE_ID_RE.match(candidate):
        return None, "Space ID must be 3–32 characters: letters, numbers, hyphens or underscores only, and can't start with a hyphen or underscore."
    if candidate in rooms_state:
        return None, f'"{candidate}" is already in use — choose a different Space ID.'
    return candidate, None


@app.route("/api/spaces", methods=["POST"])
def create_space():
    data = request.get_json(force=True) or {}

    space_id, error = validate_space_id(data.get("spaceId"))
    if error:
        return jsonify({"error": error}), 400

    password = (data.get("password") or "").strip()
    requested_idl = (data.get("idl") or "").strip().upper() or None
    want_co_host_key = bool(data.get("generateCoHostKey"))

    idl = None
    if requested_idl:
        # Host supplied a custom IDL — only use it if it's actually free.
        if requested_idl not in idl_index:
            idl = requested_idl

    co_host_key = gen_co_host_key() if want_co_host_key else None

    room = _new_room(data.get("spaceName") or "Untitled Space", password, idl, co_host_key)
    rooms_state[space_id] = room
    if idl:
        idl_index[idl] = space_id

    return jsonify({
        "spaceId": space_id,
        "idl": idl,
        "coHostKey": co_host_key,
        "hostToken": room["host_token"],
    })


@app.route("/api/spaces/check-id/<space_id>", methods=["GET"])
def check_space_id(space_id):
    """Lets the create form validate the host's chosen ID as they type,
    before submitting — same validation the POST endpoint enforces."""
    clean, error = validate_space_id(space_id)
    return jsonify({"available": error is None, "error": error})


@app.route("/api/spaces/suggest-idl", methods=["GET"])
def suggest_idl():
    """Generates a fresh, currently-unused Space IDL for the create form's
    'Suggest Space IDL' button. Does not reserve it — reservation happens
    when the Space is actually created with this value."""
    return jsonify({"idl": gen_space_idl()})


@app.route("/api/spaces/<space_id>", methods=["GET"])
def get_space(space_id):
    """Source-of-truth existence + lifecycle check. The join page calls
    this before ever attempting a socket join, so a nonexistent or ended
    Space ID is rejected with a clear message instead of silently
    admitting whoever typed a plausible-looking string."""
    room = rooms_state.get(space_id)
    if not room:
        return jsonify({"exists": False}), 404
    return jsonify(_room_public_state(room))


@app.route("/api/spaces/resolve-idl/<idl>", methods=["GET"])
def resolve_idl(idl):
    """Space IDL join lookup: maps an IDL straight to its Space ID so the
    join page can redirect into /meeting/<space_id> without a password."""
    space_id = idl_index.get(idl.strip().upper())
    room = rooms_state.get(space_id) if space_id else None
    if not room:
        return jsonify({"exists": False}), 404
    return jsonify({"exists": True, "spaceId": space_id})


@app.route("/api/spaces/<space_id>/qr", methods=["GET"])
def space_qr(space_id):
    """Server-side QR generation — no external CDN dependency, so it can
    never fail because a script from jsdelivr/etc. didn't load in time or
    was blocked. Uses request.host_url so the encoded link always points
    at wherever this instance is actually running (localhost while
    developing, the real Render domain once deployed) rather than a
    hardcoded address."""
    if not QR_AVAILABLE:
        return jsonify({
            "error": "QR generation isn't available on the server — install "
                      "the 'qrcode' and 'Pillow' packages from requirements.txt."
        }), 503

    if space_id not in rooms_state:
        return jsonify({"error": "Space not found."}), 404

    join_url = url_for("meeting", space_id=space_id, _external=True)

    img = qrcode.make(join_url, box_size=8, border=2)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return send_file(buf, mimetype="image/png")


# ---------------------------------------------------------------------------
# Socket.IO signaling
# ---------------------------------------------------------------------------

@socketio.on("join-space")
def handle_join_space(data):
    """A participant joins a Space. The server is the sole source of truth
    for whether a Space exists and what state it's in — a client can never
    cause a Space to spring into existence just by naming one (this was
    v0.7's bug #4: joining a random, never-created Space ID silently
    worked because the server auto-created a room on first join. Fixed:
    an unknown space_id is now rejected outright).

    Joining via Space IDL is resolved to a real space_id by the client
    before this event ever fires (see /api/spaces/resolve-idl), so by the
    time we're here we always operate on a real space_id."""
    space_id = data.get("spaceId")
    name = (data.get("name") or "Guest").strip()[:40]
    supplied_password = (data.get("password") or "").strip()
    supplied_co_host_key = (data.get("coHostKey") or "").strip()
    host_token = (data.get("hostToken") or "").strip()
    participant_token = (data.get("participantToken") or "").strip() or gen_secure_token()

    room = rooms_state.get(space_id)
    if not room:
        emit("join-rejected", {"reason": "not-found"})
        return

    if room["lifecycle"] == LIFECYCLE_ENDED:
        emit("join-rejected", {"reason": "ended"})
        return

    if participant_token in room["blocked_tokens"]:
        # Still rejected — being blocked never grants entry on its own,
        # per spec section 15 the moderator gets a notice (rate-limited,
        # not on every retry) rather than the attempt being silent.
        last_notified = room["blocked_retry_notified_at"].get(participant_token, 0)
        if time.time() - last_notified > BLOCKED_RETRY_NOTIFY_COOLDOWN:
            room["blocked_retry_notified_at"][participant_token] = time.time()
            for sid, info in room["participants"].items():
                if _can_moderate(info):
                    emit("blocked-retry-notice", {"name": name}, to=sid)
        emit("join-rejected", {"reason": "blocked"})
        return

    if room.get("password") and room["password"] != supplied_password:
        # A valid Co-host Key stands in for the password for someone who
        # doesn't have it — it's a separate credential, not a bypass of a
        # correct password check for people who do have the password.
        if not (supplied_co_host_key and room.get("co_host_key") and supplied_co_host_key == room["co_host_key"]):
            emit("join-rejected", {"reason": "wrong-password"})
            return

    # Determine role. Authority comes from server-issued tokens, never
    # from a typed display name — someone typing "EtoroJah" is not
    # EtoroJah unless their host_token matches this room's.
    is_returning_host = bool(host_token) and host_token == room.get("host_token")
    is_co_host_key_holder = bool(supplied_co_host_key) and supplied_co_host_key == room.get("co_host_key")

    if is_returning_host:
        role = ROLE_HOST
        room["host_sid"] = request.sid
    elif room["host_sid"] is None and is_co_host_key_holder:
        # A co-host key holder may start an unstarted/host-absent Space,
        # but this never makes them the Host — see spec: starting a Space
        # does not transfer ownership.
        role = ROLE_COHOST
    elif is_co_host_key_holder:
        role = ROLE_COHOST
    else:
        role = ROLE_PARTICIPANT

    # Space lifecycle: only a host or a co-host-key holder can move a
    # Space from "created" to "active". A plain participant arriving at
    # an unstarted Space waits instead of silently entering.
    if room["lifecycle"] == LIFECYCLE_CREATED:
        if role in (ROLE_HOST, ROLE_COHOST):
            room["lifecycle"] = LIFECYCLE_ACTIVE
        else:
            emit("join-rejected", {
                "reason": "not-started",
                "spaceName": room["name"],
            })
            return

    # Admission mode: a participant (not host/co-host) with otherwise
    # valid credentials waits for an explicit admit before joining.
    if room["admission_mode"] and role == ROLE_PARTICIPANT:
        room["pending_admission"][request.sid] = {
            "name": name,
            "participant_token": participant_token,
        }
        emit("waiting-for-admission", {
            "spaceName": room["name"],
            "participantToken": participant_token,
        })
        # Notify host/co-hosts of the request, rate-limited implicitly by
        # only firing once per join attempt (not on every reconnect retry).
        for sid, info in room["participants"].items():
            if _can_moderate(info):
                emit("admission-requested", {
                    "sid": request.sid,
                    "name": name,
                }, to=sid)
        return

    _admit_participant(room, space_id, request.sid, name, role, participant_token, host_token)


def _admit_participant(room, space_id, sid, name, role, participant_token, host_token):
    room["participants"][sid] = {
        "name": name,
        "participant_token": participant_token,
        "mic": True,
        "cam": True,
        "hand_raised": False,
        "role": role,
        "spotlighted": False,
        "screen_sharing": False,
        "avatar": None,  # data URL, set via update-avatar; None = show initials
    }

    join_room(space_id)

    existing = {s: info for s, info in room["participants"].items() if s != sid}
    emit("space-state", {
        "yourId": sid,
        "role": role,
        "participantToken": participant_token,
        "spaceName": room["name"],
        "locked": bool(room.get("password")),
        "idl": room.get("idl"),
        "admissionMode": room["admission_mode"],
        "isOriginalHost": role == ROLE_HOST and host_token == room.get("host_token"),
        "hostToken": room["host_token"] if role == ROLE_HOST else None,
        "participants": existing,
    }, to=sid)

    emit("participant-joined", {
        "id": sid,
        **room["participants"][sid],
    }, to=space_id, include_self=False)


@socketio.on("admit-participant")
def handle_admit(data):
    space_id, room = _find_room_for_sid(request.sid)
    if not room or not _can_moderate(room["participants"][request.sid]):
        return
    target_sid = data.get("sid")
    pending = room["pending_admission"].pop(target_sid, None)
    if not pending:
        return
    emit("admission-approved", {}, to=target_sid)
    _admit_participant(room, space_id, target_sid, pending["name"], ROLE_PARTICIPANT, pending["participant_token"], "")


@socketio.on("dismiss-admission")
def handle_dismiss_admission(data):
    space_id, room = _find_room_for_sid(request.sid)
    if not room or not _can_moderate(room["participants"][request.sid]):
        return
    target_sid = data.get("sid")
    if room["pending_admission"].pop(target_sid, None):
        emit("admission-dismissed", {}, to=target_sid)


@socketio.on("set-admission-mode")
def handle_set_admission_mode(data):
    space_id, room = _find_room_for_sid(request.sid)
    if not room or not _can_moderate(room["participants"][request.sid]):
        return
    room["admission_mode"] = bool(data.get("enabled"))
    emit("admission-mode-changed", {"enabled": room["admission_mode"]}, to=space_id)


@socketio.on("webrtc-offer")
def handle_offer(data):
    emit("webrtc-offer", {
        "from": request.sid,
        "sdp": data.get("sdp"),
    }, to=data.get("to"))


@socketio.on("webrtc-answer")
def handle_answer(data):
    emit("webrtc-answer", {
        "from": request.sid,
        "sdp": data.get("sdp"),
    }, to=data.get("to"))


@socketio.on("webrtc-ice-candidate")
def handle_ice(data):
    emit("webrtc-ice-candidate", {
        "from": request.sid,
        "candidate": data.get("candidate"),
    }, to=data.get("to"))


@socketio.on("update-media-state")
def handle_media_state(data):
    space_id, room = _find_room_for_sid(request.sid)
    if not room:
        return
    info = room["participants"][request.sid]
    if "mic" in data:
        info["mic"] = bool(data["mic"])
    if "cam" in data:
        info["cam"] = bool(data["cam"])
    emit("participant-updated", {"id": request.sid, **info}, to=space_id, include_self=False)


@socketio.on("rename-self")
def handle_rename_self(data):
    """Display-name change only — never a security identity (see
    participant_token, which never changes on rename), so a renamed
    participant is still recognized correctly by the block-list."""
    space_id, room = _find_room_for_sid(request.sid)
    if not room:
        return
    new_name = (data.get("name") or "").strip()[:40]
    if not new_name:
        return
    room["participants"][request.sid]["name"] = new_name
    emit("participant-updated", {"id": request.sid, **room["participants"][request.sid]}, to=space_id)


MAX_AVATAR_BYTES = 300_000  # ~300KB — generous for a small profile image, cheap to hold in memory


@socketio.on("update-avatar")
def handle_update_avatar(data):
    space_id, room = _find_room_for_sid(request.sid)
    if not room:
        return
    avatar = data.get("avatar")
    if avatar is None:
        room["participants"][request.sid]["avatar"] = None
    else:
        if not isinstance(avatar, str) or not avatar.startswith("data:image/"):
            emit("avatar-rejected", {"reason": "invalid-format"})
            return
        if len(avatar) > MAX_AVATAR_BYTES:
            emit("avatar-rejected", {"reason": "too-large"})
            return
        room["participants"][request.sid]["avatar"] = avatar
    emit("participant-updated", {"id": request.sid, **room["participants"][request.sid]}, to=space_id)


@socketio.on("raise-hand")
def handle_raise_hand(data):
    space_id, room = _find_room_for_sid(request.sid)
    if not room:
        return
    info = room["participants"][request.sid]
    info["hand_raised"] = bool(data.get("raised", True))
    emit("participant-updated", {"id": request.sid, **info}, to=space_id, include_self=False)


@socketio.on("lower-hand")
def handle_lower_hand(data):
    """Host/co-host lowers a participant's hand."""
    space_id, room = _find_room_for_sid(request.sid)
    if not room or not _can_moderate(room["participants"][request.sid]):
        return
    target_sid = data.get("targetId")
    if target_sid in room["participants"]:
        room["participants"][target_sid]["hand_raised"] = False
        emit("participant-updated", {"id": target_sid, **room["participants"][target_sid]}, to=space_id)


@socketio.on("send-reaction")
def handle_reaction(data):
    space_id, room = _find_room_for_sid(request.sid)
    if not room:
        return
    emit("reaction", {
        "from": request.sid,
        "name": room["participants"][request.sid]["name"],
        "emoji": data.get("emoji", "👍"),
    }, to=space_id)


@socketio.on("send-chat")
def handle_chat(data):
    space_id, room = _find_room_for_sid(request.sid)
    if not room:
        return
    info = room["participants"][request.sid]
    emit("chat-message", {
        "from": request.sid,
        "name": info["name"],
        "text": (data.get("text") or "")[:2000],
        "ts": time.time(),
    }, to=space_id)


@socketio.on("spotlight-participant")
def handle_spotlight(data):
    space_id, room = _find_room_for_sid(request.sid)
    if not room or not _can_moderate(room["participants"][request.sid]):
        return  # only host/co-host can spotlight
    target_sid = data.get("targetId")  # None clears spotlight
    for sid, info in room["participants"].items():
        info["spotlighted"] = (sid == target_sid)
    emit("spotlight-changed", {"targetId": target_sid}, to=space_id)


@socketio.on("screen-share-state")
def handle_screen_share(data):
    space_id, room = _find_room_for_sid(request.sid)
    if not room:
        return
    room["participants"][request.sid]["screen_sharing"] = bool(data.get("sharing"))
    emit("participant-updated", {"id": request.sid, **room["participants"][request.sid]}, to=space_id, include_self=False)


@socketio.on("host-mute-participant")
def handle_host_mute(data):
    space_id, room = _find_room_for_sid(request.sid)
    if not room or not _can_moderate(room["participants"][request.sid]):
        return
    target_sid = data.get("targetId")
    if target_sid in room["participants"]:
        room["participants"][target_sid]["mic"] = False
        emit("forced-mute", {}, to=target_sid)
        emit("participant-updated", {"id": target_sid, **room["participants"][target_sid]}, to=space_id)


@socketio.on("mute-everyone")
def handle_mute_everyone(data):
    """Mutes every participant except the requester — a host/co-host
    muting the room does not accidentally mute themself."""
    space_id, room = _find_room_for_sid(request.sid)
    if not room or not _can_moderate(room["participants"][request.sid]):
        return
    for sid, info in room["participants"].items():
        if sid == request.sid:
            continue
        info["mic"] = False
        emit("forced-mute", {}, to=sid)
        emit("participant-updated", {"id": sid, **info}, to=space_id)


@socketio.on("ask-to-unmute")
def handle_ask_to_unmute(data):
    """Requests, never forces — the participant decides whether to
    actually turn their microphone back on."""
    space_id, room = _find_room_for_sid(request.sid)
    if not room or not _can_moderate(room["participants"][request.sid]):
        return
    target_sid = data.get("targetId")
    if target_sid in room["participants"]:
        emit("unmute-requested", {
            "byName": room["participants"][request.sid]["name"],
        }, to=target_sid)


@socketio.on("request-co-host")
def handle_request_co_host(data):
    """A participant asks to become co-host. Notifies host/co-hosts with
    a real accept/reject action — the server enforces the resulting role
    change, not the client."""
    space_id, room = _find_room_for_sid(request.sid)
    if not room:
        return
    requester = room["participants"][request.sid]
    if requester["role"] != ROLE_PARTICIPANT:
        return  # already host/co-host — nothing to request
    for sid, info in room["participants"].items():
        if _can_moderate(info):
            emit("co-host-requested", {
                "sid": request.sid,
                "name": requester["name"],
            }, to=sid)


@socketio.on("respond-co-host-request")
def handle_respond_co_host_request(data):
    space_id, room = _find_room_for_sid(request.sid)
    if not room or not _can_moderate(room["participants"][request.sid]):
        return
    target_sid = data.get("targetId")
    approve = bool(data.get("approve"))
    if target_sid not in room["participants"]:
        return
    if approve and room["participants"][target_sid]["role"] == ROLE_PARTICIPANT:
        room["participants"][target_sid]["role"] = ROLE_COHOST
        emit("participant-updated", {"id": target_sid, **room["participants"][target_sid]}, to=space_id)
        emit("role-changed", {"role": ROLE_COHOST}, to=target_sid)
    else:
        emit("co-host-request-declined", {}, to=target_sid)


@socketio.on("make-co-host")
def handle_make_co_host(data):
    """A verified host OR co-host may promote a participant to co-host —
    the server decides based on the requester's authoritative role, never
    a client-asserted one."""
    space_id, room = _find_room_for_sid(request.sid)
    if not room or not _can_moderate(room["participants"][request.sid]):
        return
    target_sid = data.get("targetId")
    if target_sid in room["participants"] and room["participants"][target_sid]["role"] == ROLE_PARTICIPANT:
        room["participants"][target_sid]["role"] = ROLE_COHOST
        emit("participant-updated", {"id": target_sid, **room["participants"][target_sid]}, to=space_id)
        emit("role-changed", {"role": ROLE_COHOST}, to=target_sid)


@socketio.on("revoke-co-host")
def handle_revoke_co_host(data):
    """Only the host may demote a co-host back to participant."""
    space_id, room = _find_room_for_sid(request.sid)
    if not room or not _is_host(room["participants"][request.sid]):
        return
    target_sid = data.get("targetId")
    if target_sid in room["participants"] and room["participants"][target_sid]["role"] == ROLE_COHOST:
        room["participants"][target_sid]["role"] = ROLE_PARTICIPANT
        emit("participant-updated", {"id": target_sid, **room["participants"][target_sid]}, to=space_id)
        emit("role-changed", {"role": ROLE_PARTICIPANT}, to=target_sid)


@socketio.on("transfer-host")
def handle_transfer_host(data):
    """Only the current host may transfer host status. Explicit,
    confirmed action (the client shows a confirmation dialog before ever
    sending this) — never a casual one-click role change."""
    space_id, room = _find_room_for_sid(request.sid)
    if not room or not _is_host(room["participants"][request.sid]):
        return
    target_sid = data.get("targetId")
    if target_sid not in room["participants"] or target_sid == request.sid:
        return

    # Old host becomes co-host; a fresh host_token is minted so the old
    # host's stored token no longer grants host authority.
    room["participants"][request.sid]["role"] = ROLE_COHOST
    room["participants"][target_sid]["role"] = ROLE_HOST
    room["host_sid"] = target_sid
    room["host_token"] = gen_secure_token()

    emit("participant-updated", {"id": request.sid, **room["participants"][request.sid]}, to=space_id)
    emit("participant-updated", {"id": target_sid, **room["participants"][target_sid]}, to=space_id)
    emit("role-changed", {"role": ROLE_COHOST}, to=request.sid)
    emit("role-changed", {"role": ROLE_HOST, "hostToken": room["host_token"]}, to=target_sid)


@socketio.on("host-remove-participant")
def handle_host_remove(data):
    space_id, room = _find_room_for_sid(request.sid)
    if not room or not _can_moderate(room["participants"][request.sid]):
        return
    target_sid = data.get("targetId")
    block = bool(data.get("block"))
    if target_sid in room["participants"]:
        if block:
            token = room["participants"][target_sid]["participant_token"]
            room["blocked_tokens"].add(token)
            room["blocked_names"][token] = room["participants"][target_sid]["name"]
        emit("removed-from-space", {"blocked": block}, to=target_sid)
        del room["participants"][target_sid]
        leave_room(space_id, sid=target_sid)
        emit("participant-left", {"id": target_sid}, to=space_id)
        emit("blocked-list-updated", _blocked_list(room), to=space_id)


@socketio.on("allow-rejoin")
def handle_allow_rejoin(data):
    """Reverses a prior Block — the given participant_token may attempt
    to join again. Requires the actual token, not a display name, since
    a blocked person's name means nothing to the server's identity model."""
    space_id, room = _find_room_for_sid(request.sid)
    if not room or not _can_moderate(room["participants"][request.sid]):
        return
    token = (data.get("participantToken") or "").strip()
    room["blocked_tokens"].discard(token)
    room["blocked_retry_notified_at"].pop(token, None)
    room["blocked_names"].pop(token, None)
    emit("blocked-list-updated", _blocked_list(room), to=space_id)


@socketio.on("get-blocked-list")
def handle_get_blocked_list(data):
    space_id, room = _find_room_for_sid(request.sid)
    if not room or not _can_moderate(room["participants"][request.sid]):
        return
    emit("blocked-list-updated", _blocked_list(room))


def _blocked_list(room):
    return {"blocked": [
        {"participantToken": t, "name": room["blocked_names"].get(t, "Unknown")}
        for t in room["blocked_tokens"]
    ]}


@socketio.on("end-meeting")
def handle_end_meeting(data):
    """Server-authorized termination of the whole Space. Only the current
    host may end a meeting — a co-host starting a Space does not grant
    them this authority."""
    space_id, room = _find_room_for_sid(request.sid)
    if not room or not _is_host(room["participants"][request.sid]):
        return

    room["lifecycle"] = LIFECYCLE_ENDED
    emit("meeting-ended", {}, to=space_id)

    for sid in list(room["participants"].keys()):
        leave_room(space_id, sid=sid)

    if room.get("idl") in idl_index:
        del idl_index[room["idl"]]
    del rooms_state[space_id]


@socketio.on("disconnect")
def handle_disconnect():
    space_id, room = _find_room_for_sid(request.sid)
    if not room:
        return
    was_host = _is_host(room["participants"][request.sid])
    del room["participants"][request.sid]
    emit("participant-left", {"id": request.sid}, to=space_id)

    if not room["participants"]:
        # Empty room, but NOT explicitly ended — a host closing their
        # browser is not the same as End Meeting (spec section 36).
        # We still garbage-collect the in-memory room since nobody is
        # left to rejoin it in this simple single-process model, but we
        # do not mark it "ended": if the same space_id is used again it
        # is treated as a fresh create, not a resurrection of an ended
        # Space (that distinction only matters once ended Spaces are
        # persisted past process lifetime).
        if room.get("idl") in idl_index:
            del idl_index[room["idl"]]
        del rooms_state[space_id]
        return

    if was_host:
        # Host disconnecting (not ending) leaves the room active. Promote
        # the earliest-joined remaining participant (preferring an
        # existing co-host, if any) to host for continuity — but this is
        # a *connected-host* handoff, not a change to who the original
        # authoritative host is; if the true host reconnects with a
        # valid host_token they resume the host role (see join-space).
        candidates = list(room["participants"].items())
        co_hosts = [sid for sid, info in candidates if info["role"] == ROLE_COHOST]
        new_host_sid = co_hosts[0] if co_hosts else candidates[0][0]
        room["host_sid"] = new_host_sid
        room["participants"][new_host_sid]["role"] = ROLE_HOST
        emit("participant-updated", {"id": new_host_sid, **room["participants"][new_host_sid]}, to=space_id)
        emit("you-are-host", {}, to=new_host_sid)


if __name__ == "__main__":
    socketio.run(app, debug=True, host="0.0.0.0", port=5000, allow_unsafe_werkzeug=True)


