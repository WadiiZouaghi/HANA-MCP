from pathlib import Path

from flask import Flask, send_from_directory

from api import api


BACKEND_DIR = Path(__file__).parent
FRONTEND_DIR = BACKEND_DIR.parent / "front"

app = Flask(__name__, static_folder=str(FRONTEND_DIR), static_url_path="/static")


app.register_blueprint(
    api,
    url_prefix="/api"
)



@app.route("/")
def home():
    return send_from_directory(FRONTEND_DIR, "index.html")



if __name__ == "__main__":

    app.run(
        host="0.0.0.0",
        port=5000,
        debug=True
    )
