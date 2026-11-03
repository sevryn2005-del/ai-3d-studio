from fastapi import Request

from app.cad.worker_pool import WorkerPool


def get_cad_pool(request: Request) -> WorkerPool:
    return request.app.state.cad_pool
