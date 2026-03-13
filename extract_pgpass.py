import sqlite3
import os
import sys

db_path = os.path.expandvars(r'%APPDATA%\pgAdmin\pgadmin4.db')

if not os.path.exists(db_path):
    print(f"pgAdmin database not found at: {db_path}")
    sys.exit(1)

print(f"Reading: {db_path}\n")
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# List all tables
cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
tables = [t[0] for t in cursor.fetchall()]
print("Tables found:", tables)

# Find server with our IP
print("\n--- Servers ---")
try:
    cursor.execute("SELECT id, name, host, port, username, password FROM server")
    for s in cursor.fetchall():
        print(f"  Name: {s[1]}, Host: {s[2]}:{s[3]}, User: {s[4]}, Pass(encrypted): {s[5]}")
except Exception as e:
    print(f"  Error reading server table: {e}")

# Check for encryption keys table
print("\n--- Keys ---")
try:
    cursor.execute("SELECT * FROM keys")
    for k in cursor.fetchall():
        print(f"  {k}")
except Exception as e:
    print(f"  No keys table: {e}")

# Check for user table (has secret key info)
print("\n--- Users ---")
try:
    cursor.execute("SELECT id, email, password FROM user")
    for u in cursor.fetchall():
        print(f"  ID: {u[0]}, Email: {u[1]}, Pass hash: {u[2]}")
except Exception as e:
    print(f"  Error: {e}")

conn.close()

# Now try to decrypt using Fernet
print("\n--- Attempting Decryption ---")
try:
    from cryptography.fernet import Fernet
    import base64
    import hashlib

    # Re-open to get encrypted password and try decryption
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    cursor.execute("SELECT username, password FROM server WHERE host='4.213.208.124'")
    row = cursor.fetchone()
    if not row:
        cursor.execute("SELECT username, password FROM server")
        row = cursor.fetchone()

    if row and row[1]:
        username, enc_pass = row
        print(f"  User: {username}, Encrypted: {enc_pass}")

        # Try getting secret key from keys table
        try:
            cursor.execute("SELECT key FROM keys WHERE name='DESKTOP-PGADMIN4-MASTER'")
            key_row = cursor.fetchone()
            if key_row:
                secret = key_row[0]
                key = base64.urlsafe_b64encode(hashlib.sha256(secret.encode()).digest())
                f = Fernet(key)
                decrypted = f.decrypt(enc_pass.encode()).decode()
                print(f"  DECRYPTED PASSWORD: {decrypted}")
        except Exception as e:
            print(f"  Key decrypt attempt failed: {e}")

        # Try with empty master password (common default)
        try:
            key = base64.urlsafe_b64encode(hashlib.sha256(b'').digest())
            f = Fernet(key)
            decrypted = f.decrypt(enc_pass.encode()).decode()
            print(f"  DECRYPTED PASSWORD (empty key): {decrypted}")
        except Exception as e:
            print(f"  Empty key attempt failed: {e}")

    conn.close()

except ImportError:
    print("  'cryptography' package not installed. Run: pip install cryptography")
except Exception as e:
    print(f"  Decryption error: {e}")
