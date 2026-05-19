"""Local Firebase Admin SDK tool for AppBeg administrator management."""

from __future__ import annotations

import argparse
import getpass
import hmac
import os
import sys
from pathlib import Path
from typing import Any


ACTIONS = (
    "create_admin",
    "promote_to_admin",
    "demote_admin",
    "disable_user",
)


def log(message: str) -> None:
    print(f"[admin-tool] {message}")


def fail(message: str) -> None:
    print(f"[admin-tool] ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def require_master_secret() -> None:
    expected = os.environ.get("APPBEG_ADMIN_MASTER_SECRET")
    if not expected:
        fail("APPBEG_ADMIN_MASTER_SECRET is not set.")

    entered = getpass.getpass("Master secret: ")
    if not hmac.compare_digest(entered, expected):
        fail("Master secret did not match.")

    log("Master secret accepted.")


def require_service_account_path() -> Path:
    raw_path = os.environ.get("APPBEG_SERVICE_ACCOUNT_PATH")
    if not raw_path:
        fail("APPBEG_SERVICE_ACCOUNT_PATH is not set.")

    path = Path(raw_path).expanduser()
    if not path.is_file():
        fail(f"Service account JSON was not found: {path}")

    return path


def initialize_firebase() -> tuple[Any, Any]:
    service_account_path = require_service_account_path()

    try:
        import firebase_admin
        from firebase_admin import auth, credentials, firestore
    except ImportError:
        fail("Python package firebase-admin is required. Install it with: python -m pip install firebase-admin")

    if not firebase_admin._apps:
        cred = credentials.Certificate(str(service_account_path))
        firebase_admin.initialize_app(cred)

    log(f"Firebase Admin SDK initialized with service account: {service_account_path}")
    return auth, firestore


def prompt_nonempty(label: str) -> str:
    value = input(f"{label}: ").strip()
    if not value:
        fail(f"{label} is required.")
    return value


def normalize_username(username: str) -> str:
    clean = username.strip().lower()
    if not clean:
        fail("Username is required.")
    if "@" in clean:
        fail("Username must not contain '@'. The tool creates username@app.local automatically.")
    return clean


def choose_action(action: str | None) -> str:
    if action:
        return action

    print("Choose action:")
    for index, name in enumerate(ACTIONS, start=1):
        print(f"  {index}. {name}")

    selection = prompt_nonempty("Action").lower()
    if selection.isdigit():
        selected_index = int(selection)
        if 1 <= selected_index <= len(ACTIONS):
            return ACTIONS[selected_index - 1]

    if selection in ACTIONS:
        return selection

    fail(f"Unknown action: {selection}")


def find_user_doc(db: Any, identifier: str) -> tuple[str, dict[str, Any]]:
    clean_identifier = identifier.strip()
    if not clean_identifier:
        fail("UID or username is required.")

    direct_ref = db.collection("users").document(clean_identifier)
    direct_snap = direct_ref.get()
    if direct_snap.exists:
        return clean_identifier, direct_snap.to_dict() or {}

    username = normalize_username(clean_identifier)
    matches = list(db.collection("users").where("username", "==", username).limit(2).stream())
    if not matches:
        fail(f"No user found for UID or username: {clean_identifier}")
    if len(matches) > 1:
        fail(f"Multiple users found for username: {username}")

    snap = matches[0]
    return snap.id, snap.to_dict() or {}


def create_admin(auth: Any, firestore: Any, db: Any) -> None:
    username = normalize_username(prompt_nonempty("Username"))
    password = getpass.getpass("Password: ")
    if len(password) < 6:
        fail("Password must be at least 6 characters.")

    email = f"{username}@app.local"
    log(f"Checking whether username already exists: {username}")
    existing_users = list(db.collection("users").where("username", "==", username).limit(1).stream())
    if existing_users:
        fail(f"Username already exists: {username}")

    log(f"Creating Firebase Auth user for username: {username}")
    user = auth.create_user(email=email, password=password, disabled=False)

    log(f"Writing Firestore users/{user.uid} admin profile.")
    db.collection("users").document(user.uid).set(
        {
            "role": "admin",
            "username": username,
            "email": email,
            "status": "active",
            "createdAt": firestore.SERVER_TIMESTAMP,
            "createdBy": None,
            "coadminUid": None,
        }
    )

    log(f"Created admin user uid={user.uid} username={username}")


def promote_to_admin(db: Any) -> None:
    identifier = prompt_nonempty("UID or username")
    uid, data = find_user_doc(db, identifier)
    log(f"Promoting users/{uid} username={data.get('username', '<missing>')} to admin.")
    db.collection("users").document(uid).update({"role": "admin"})
    log(f"Promotion complete for uid={uid}.")


def demote_admin(auth: Any, db: Any) -> None:
    identifier = prompt_nonempty("UID or username")
    uid, data = find_user_doc(db, identifier)
    username = data.get("username", "<missing>")

    print(f"About to disable admin uid={uid} username={username}.")
    print("This is safer than converting the account to staff because it removes access.")
    confirmation = input(f"Type DISABLE {uid} to confirm: ").strip()
    if confirmation != f"DISABLE {uid}":
        fail("Confirmation did not match; no changes were made.")

    log(f"Disabling Auth user and Firestore profile for uid={uid}.")
    auth.update_user(uid, disabled=True)
    db.collection("users").document(uid).update({"role": "staff", "status": "disabled"})
    log(f"Demotion complete for uid={uid}; account is disabled.")


def disable_user(auth: Any, db: Any) -> None:
    identifier = prompt_nonempty("UID or username")
    uid, data = find_user_doc(db, identifier)
    username = data.get("username", "<missing>")

    print(f"About to disable uid={uid} username={username}.")
    confirmation = input(f"Type DISABLE {uid} to confirm: ").strip()
    if confirmation != f"DISABLE {uid}":
        fail("Confirmation did not match; no changes were made.")

    log(f"Disabling Auth user and Firestore profile for uid={uid}.")
    auth.update_user(uid, disabled=True)
    db.collection("users").document(uid).update({"status": "disabled"})
    log(f"Disabled uid={uid}.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Local-only AppBeg admin management tool. Admin bootstrap must be done "
            "by local Firebase Admin SDK tool, not browser."
        )
    )
    parser.add_argument(
        "--action",
        choices=ACTIONS,
        help="Run one action directly instead of choosing from the interactive menu.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    # Admin bootstrap must be done by local Firebase Admin SDK tool, not browser.
    require_master_secret()
    action = choose_action(args.action)
    auth, firestore = initialize_firebase()
    db = firestore.client()

    if action == "create_admin":
        create_admin(auth, firestore, db)
    elif action == "promote_to_admin":
        promote_to_admin(db)
    elif action == "demote_admin":
        demote_admin(auth, db)
    elif action == "disable_user":
        disable_user(auth, db)
    else:
        fail(f"Unknown action: {action}")


if __name__ == "__main__":
    main()
