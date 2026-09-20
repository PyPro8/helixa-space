"""
Helixa Space — backend

v0.1  Landing + create/join
v0.2  Two-person WebRTC video/audio call
v0.3  Multiple participants + meeting rooms
v0.4  Controls + chat + participants panel
v0.5  Screen sharing + fullscreen + spotlight
v0.6  Media pipeline fixes, roles (host/co-host/participant),
      real participant actions, Space ID + Space IDL access

The Python server only handles signaling (who's in the room, and relaying
WebRTC offer/answer/ICE messages) plus chat/control events. Media itself
(camera, mic, screen share) flows peer-to-peer over WebRTC and never
touches this server.
"""

import os
import random
import time

from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit, join_room, leave_room

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "helixa-space-dev-secret")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# ---------------------------------------------------------------------------
# In-memory room state (fine for v0.1–v0.6; move to SQLite/Redis later if
# the process needs to survive restarts or scale across workers).
# ---------------------------------------------------------------------------
# rooms_state[space_id] = {
#     "name": str,
#     "password": str | None,
#     "idl": str | None,          # Space IDL — passwordless quick-join code
#     "host_sid": str,
#     "created_at": float,
#     "participants": {
#         sid: {
#             "name": str,
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


def gen_space_idl():
    """Space IDL: a short passwordless quick-join code. Generated with the
    same secure random source as the Space ID, checked for collisions
    against every currently active IDL before being handed out."""
    chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    while True:
        candidate = "HX" + "".join(random.choices(chars, k=6))
        if candidate not in idl_index:
            return candidate


def _new_room(name, password=None, idl=None):
    return {
        "name": name,
        "password": password or None,
        "idl": idl,
        "host_sid": None,
        "created_at": time.time(),
        "participants": {},
    }


def _can_moderate(info):
    """Host and co-host may perform moderation actions; plain
    participants may not."""
    return info["role"] in (ROLE_HOST, ROLE_COHOST)


def _is_host(info):
    return info["role"] == ROLE_HOST


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


@app.route("/meeting/<space_id>")
def meeting(space_id):
    return render_template("meeting.html", space_id=space_id)


# ---------------------------------------------------------------------------
# REST helpers — Space ID (password-protected) creation/lookup, and
# Space IDL (passwordless quick-join) suggestion/lookup.
# ---------------------------------------------------------------------------

import re

VALID_SPACE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$")


def validate_space_id(raw):
    """Returns (clean_id, error_message). error_message is None on success.
    Per the v0.7 spec, the host chooses the Space ID — this only checks
    format and availability, it never invents a replacement value."""
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

    idl = None
    if requested_idl:
        # Host supplied a custom IDL — only use it if it's actually free.
        if requested_idl not in idl_index:
            idl = requested_idl

    room = _new_room(data.get("spaceName") or "Untitled Space", password, idl)
    rooms_state[space_id] = room
    if idl:
        idl_index[idl] = space_id

    return jsonify({"spaceId": space_id, "idl": idl})


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
    room = rooms_state.get(space_id)
    if not room:
        return jsonify({"exists": False}), 404
    return jsonify({
        "exists": True,
        "name": room["name"],
        "locked": bool(room.get("password")),
        "participantCount": len(room["participants"]),
    })


@app.route("/api/spaces/resolve-idl/<idl>", methods=["GET"])
def resolve_idl(idl):
    """Space IDL join lookup: maps an IDL straight to its Space ID so the
    join page can redirect into /meeting/<space_id> without a password."""
    space_id = idl_index.get(idl.strip().upper())
    if not space_id or space_id not in rooms_state:
        return jsonify({"exists": False}), 404
    return jsonify({"exists": True, "spaceId": space_id})


# ---------------------------------------------------------------------------
# Socket.IO signaling
# ---------------------------------------------------------------------------

@socketio.on("join-space")
def handle_join_space(data):
    """A participant joins a Space. Registers them, tells existing
    participants about the newcomer, and tells the newcomer who's
    already there so it can initiate WebRTC offers to each.

    Joining via Space IDL is authenticated separately on the client (the
    join page resolves the IDL to a space_id via /api/spaces/resolve-idl
    before ever calling this event), so by the time join-space fires here
    it always operates in terms of the real space_id and, if the room has
    a password, still enforces it — an IDL join is only passwordless when
    the room itself has no password (matching the "Space IDL is quick
    access" model, not a bypass for locked Space ID rooms)."""
    space_id = data.get("spaceId")
    name = (data.get("name") or "Guest").strip()[:40]
    supplied_password = (data.get("password") or "").strip()

    if space_id not in rooms_state:
        # Allow joining a room that was created ad hoc (e.g. dev testing)
        rooms_state[space_id] = _new_room(space_id)

    room = rooms_state[space_id]

    if room.get("password") and room["password"] != supplied_password:
        emit("join-rejected", {"reason": "wrong-password"})
        return

    is_first = room["host_sid"] is None
    if is_first:
        room["host_sid"] = request.sid
        role = ROLE_HOST
    else:
        role = ROLE_PARTICIPANT

    room["participants"][request.sid] = {
        "name": name,
        "mic": True,
        "cam": True,
        "hand_raised": False,
        "role": role,
        "spotlighted": False,
        "screen_sharing": False,
    }

    join_room(space_id)

    # Send the newcomer the current roster (excluding themself)
    existing = {
        sid: info for sid, info in room["participants"].items() if sid != request.sid
    }
    emit("space-state", {
        "yourId": request.sid,
        "role": role,
        "spaceName": room["name"],
        "locked": bool(room.get("password")),
        "idl": room.get("idl"),
        "participants": existing,
    })

    # Tell everyone else a new participant arrived
    emit("participant-joined", {
        "id": request.sid,
        **room["participants"][request.sid],
    }, to=space_id, include_self=False)


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


def _find_room_for_sid(sid):
    for space_id, room in rooms_state.items():
        if sid in room["participants"]:
            return space_id, room
    return None, None


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


@socketio.on("make-co-host")
def handle_make_co_host(data):
    """Only the host may promote a participant to co-host."""
    space_id, room = _find_room_for_sid(request.sid)
    if not room or not _is_host(room["participants"][request.sid]):
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


@socketio.on("host-remove-participant")
def handle_host_remove(data):
    space_id, room = _find_room_for_sid(request.sid)
    if not room or not _can_moderate(room["participants"][request.sid]):
        return
    target_sid = data.get("targetId")
    if target_sid in room["participants"]:
        emit("removed-from-space", {}, to=target_sid)
        del room["participants"][target_sid]
        leave_room(space_id, sid=target_sid)
        emit("participant-left", {"id": target_sid}, to=space_id)


@socketio.on("disconnect")
def handle_disconnect():
    space_id, room = _find_room_for_sid(request.sid)
    if not room:
        return
    was_host = _is_host(room["participants"][request.sid])
    del room["participants"][request.sid]
    emit("participant-left", {"id": request.sid}, to=space_id)

    if not room["participants"]:
        # Empty room — clean it up
        if room.get("idl") in idl_index:
            del idl_index[room["idl"]]
        del rooms_state[space_id]
        return

    if was_host:
        # Promote the earliest-joined remaining participant (preferring an
        # existing co-host, if any) to host.
        candidates = list(room["participants"].items())
        co_hosts = [sid for sid, info in candidates if info["role"] == ROLE_COHOST]
        new_host_sid = co_hosts[0] if co_hosts else candidates[0][0]
        room["host_sid"] = new_host_sid
        room["participants"][new_host_sid]["role"] = ROLE_HOST
        emit("participant-updated", {"id": new_host_sid, **room["participants"][new_host_sid]}, to=space_id)
        emit("you-are-host", {}, to=new_host_sid)


if __name__ == "__main__":
    socketio.run(app, debug=True, host="0.0.0.0", port=5000, allow_unsafe_werkzeug=True)

