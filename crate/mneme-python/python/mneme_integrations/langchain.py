"""LangChain retriever backed by mneme.

The engine does not embed text itself -- callers store and query raw vectors (see the Node and
Python quickstarts). This retriever therefore takes an `embed_query` callable rather than
assuming a specific embedding provider, the same "bring your own embeddings" contract every other
mneme integration uses.

Usage:
    from mneme_python import MnemeStore
    from mneme_integrations.langchain import MnemeRetriever

    store = MnemeStore("/path/to/data", "my-org", dim=1024)
    retriever = MnemeRetriever(store=store, embed_query=my_embedding_fn, top_k=5)
    docs = retriever.invoke("what's our warranty policy?")
"""
from typing import Callable, List

try:
    from langchain_core.callbacks import CallbackManagerForRetrieverRun
    from langchain_core.documents import Document
    from langchain_core.retrievers import BaseRetriever
    from pydantic import ConfigDict
except ImportError as e:  # pragma: no cover
    raise ImportError(
        "mneme_integrations.langchain requires langchain-core: pip install langchain-core"
    ) from e


class MnemeRetriever(BaseRetriever):
    """A LangChain `BaseRetriever` that recalls from a `mneme_python.MnemeStore`.

    `embed_query` converts the query string to the same embedding space the store's vectors were
    inserted with -- mismatched dimensions raise `ValueError` from the underlying `recall` call,
    not a silent wrong answer.
    """

    model_config = ConfigDict(arbitrary_types_allowed=True)

    store: object
    embed_query: Callable[[str], List[float]]
    top_k: int = 5
    layer: int = -1  # -1 = all layers, matching MnemeStore.recall_layer's convention

    def _get_relevant_documents(
        self, query: str, *, run_manager: "CallbackManagerForRetrieverRun"
    ) -> List["Document"]:
        vector = self.embed_query(query)
        hits = self.store.recall_layer(vector, self.top_k, self.layer)
        return [
            Document(
                page_content=h.text,
                metadata={"slot_id": h.slot_id, "score": h.score},
            )
            for h in hits
        ]
