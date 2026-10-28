import os

# numpy's and scipy's OpenBLAS each commit ~32 MB per CPU thread at import
# (~1 GB on 16 threads); the agent's math is tiny and single-threaded.
for _var in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_var, "1")
